#!/usr/bin/env node
/* Firestore security-rules gate.
 *
 *   bash tests/run-rules.sh          (starts the emulator, runs this, shuts it down)
 *
 * Why this file exists (2026-10-27): a trailing `allow read, write: if isAdmin()`
 * in the catch-all block silently OR'd over every scoped rule in firestore.rules —
 * so a `manager` could verify payments, forge `verifiedBy`, and void rows. It was
 * found by accident, and the seven probes that proved the fix were throwaway
 * console calls whose output got truncated; nothing was left behind to stop it
 * coming back. This is that probe, made permanent.
 *
 * It runs against the **Firestore emulator only**: no production project, no read
 * or write quota, no throwaway Auth accounts created at 04:00 and deleted at 04:45.
 * The ruleset under test is read from firestore.rules on disk, so the emulator can
 * never drift from the repo.
 *
 * Reading the rules is not verification. Each row below is an actual client
 * operation, and a row only passes when the emulator answers the way the rule is
 * supposed to. An unexpected error code is reported as ERROR and fails the build —
 * never silently accepted as a "deny".
 */
import { readFileSync } from "node:fs";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import {
    doc, getDoc, setDoc, updateDoc, deleteDoc, collection, addDoc, Timestamp,
} from "firebase/firestore";

const ROOT = new URL("../", import.meta.url).pathname;
const RULES = readFileSync(ROOT + "firestore.rules", "utf8");

const HOSTPORT = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8089";
const [HOST, PORT] = [HOSTPORT.split(":")[0], Number(HOSTPORT.split(":")[1] || 8089)];
const PROJECT = "demo-tgrules";

/* ------------------------------------------------------------------ reporting */
const rows = [];
let failed = 0;
let harnessErrors = 0;

const ALLOW = "allowed";
const DENY = "denied";

function record(block, label, want, got) {
    const pass = got === want;
    if (!pass) {
        if (got.startsWith("ERROR")) harnessErrors++;
        else failed++;
    }
    rows.push({ block, label, want, got, pass });
}

async function run(fn) {
    try {
        return { ok: true, val: await fn() };
    } catch (e) {
        return { ok: false, code: (e && e.code) || "", msg: String((e && e.message) || e) };
    }
}

/* A rule denial is the only acceptable "no". Anything else is a broken harness. */
async function expect(block, label, want, fn) {
    const r = await run(fn);
    let got;
    if (r.ok) got = ALLOW;
    else if (/permission-denied/.test(r.code)) got = DENY;
    else got = `ERROR ${r.code || r.msg}`.slice(0, 150);
    record(block, label, want, got);
    return r;
}

/* --------------------------------------------------------------- test fixtures */
const ts = Timestamp.fromDate(new Date("2026-10-27T00:00:00Z"));

async function seed(testEnv, { visitors = null } = {}) {
    await testEnv.clearFirestore();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        // committee roles — the whole point of the matrix
        await setDoc(doc(db, "admin_accounts", "mgr"), { name: "MGR", role: "manager" });
        await setDoc(doc(db, "admin_accounts", "tre"), { name: "TRE", role: "treasurer" });
        await setDoc(doc(db, "admin_accounts", "sup"), { name: "SUP", role: "super_admin" });

        await setDoc(doc(db, "residents", "ZZ-1"), {
            road: "ZZ TEST", unitNumber: "1", name: "Probe House",
            phone: "0000000", pin: "0000", isJoined: false,
        });

        const inv = (id, extra) => setDoc(doc(db, "invoices", id), {
            amount: 80, road: "ZZ TEST", unitNumber: "1", month: 1, year: 2026, ...extra,
        });
        await inv("ZZ-PENDING", { status: "pending" });
        await inv("ZZ-PROV-MGR", { status: "provisional", recordedBy: "mgr" });
        await inv("ZZ-PROV-TRE", { status: "provisional", recordedBy: "tre" });
        await inv("ZZ-PROV-SUP", { status: "provisional", recordedBy: "sup" });
        await inv("ZZ-PAID", {
            status: "paid", verification: "verified",
            recordedBy: "tre", verifiedBy: "tre",
        });

        await setDoc(doc(db, "visits", "ZZ-V"), { name: "Probe Visitor", status: "active" });

        if (visitors !== null) {
            await setDoc(doc(db, "settings", "taman_config"), { visitorsEnabled: visitors });
        }
    });
}

/* -------------------------------------------------------------------- the gate */
const testEnv = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules: RULES, host: HOST, port: PORT },
});

const anon = testEnv.unauthenticatedContext().firestore();
/* "stranger" = signed in, but holds no admin_accounts document. */
const stranger = testEnv.authenticatedContext("stranger").firestore();
const mgr = testEnv.authenticatedContext("mgr").firestore();
const tre = testEnv.authenticatedContext("tre").firestore();
const sup = testEnv.authenticatedContext("sup").firestore();

/* ── 1. the catch-all must never grant a write ─────────────────────────────── */
await seed(testEnv);
{
    const B = "1. catch-all (the OR trap)";
    await expect(B, "manager cannot write an unmatched path", DENY,
        () => setDoc(doc(mgr, "scratch", "d1"), { x: 1 }));
    await expect(B, "super_admin cannot write an unmatched path", DENY,
        () => setDoc(doc(sup, "scratch", "d1"), { x: 1 }));
    await expect(B, "anonymous cannot write an unmatched path", DENY,
        () => setDoc(doc(anon, "scratch", "d1"), { x: 1 }));
    await expect(B, "manager may read an unmatched path", ALLOW,
        () => getDoc(doc(mgr, "scratch", "d1")));
    await expect(B, "anonymous cannot read an unmatched path", DENY,
        () => getDoc(doc(anon, "scratch", "d1")));
}

/* ── 2. residents: the login flow may only touch the join flag ─────────────── */
await seed(testEnv);
{
    const B = "2. residents";
    await expect(B, "anonymous may read a resident (PIN login)", ALLOW,
        () => getDoc(doc(anon, "residents", "ZZ-1")));
    await expect(B, "anonymous may set isJoined + lastLoginAt", ALLOW,
        () => updateDoc(doc(anon, "residents", "ZZ-1"), { isJoined: true, lastLoginAt: ts }));
    await expect(B, "anonymous cannot rewrite a resident's name", DENY,
        () => updateDoc(doc(anon, "residents", "ZZ-1"), { name: "Hijacked" }));
    await expect(B, "anonymous cannot smuggle name alongside isJoined", DENY,
        () => updateDoc(doc(anon, "residents", "ZZ-1"), { isJoined: true, name: "Hijacked" }));
    await expect(B, "anonymous cannot rewrite a resident's PIN", DENY,
        () => updateDoc(doc(anon, "residents", "ZZ-1"), { pin: "9999" }));
    await expect(B, "anonymous cannot create a resident", DENY,
        () => setDoc(doc(anon, "residents", "ZZ-NEW"), { name: "Fake", road: "ZZ TEST" }));
    await expect(B, "anonymous cannot delete a resident", DENY,
        () => deleteDoc(doc(anon, "residents", "ZZ-1")));
    await expect(B, "signed-in non-admin cannot edit a resident", DENY,
        () => updateDoc(doc(stranger, "residents", "ZZ-1"), { name: "Hijacked" }));
    await expect(B, "manager may edit a resident", ALLOW,
        () => updateDoc(doc(mgr, "residents", "ZZ-1"), { name: "Corrected Name" }));
    await expect(B, "manager may create a resident", ALLOW,
        () => setDoc(doc(mgr, "residents", "ZZ-NEW"), { name: "New House", road: "ZZ TEST" }));
    await expect(B, "manager may delete a resident", ALLOW,
        () => deleteDoc(doc(mgr, "residents", "ZZ-NEW")));
}

/* ── 3. invoices: record ≠ verify ≠ void ──────────────────────────────────── */
await seed(testEnv);
{
    const B = "3. invoices — two-person control";
    const verify = (verifiedBy, extra = {}) => ({
        status: "paid", verification: "verified", verifiedBy,
        verifiedAt: ts, verifyNote: "MBB 27/10 ref 1234", selfVerified: false, ...extra,
    });

    await expect(B, "anonymous may read bills", ALLOW,
        () => getDoc(doc(anon, "invoices", "ZZ-PENDING")));
    await expect(B, "anonymous cannot mark a bill paid", DENY,
        () => updateDoc(doc(anon, "invoices", "ZZ-PENDING"), { status: "paid" }));
    await expect(B, "anonymous cannot create a bill", DENY,
        () => setDoc(doc(anon, "invoices", "ZZ-ANON"), { status: "pending", amount: 80 }));
    await expect(B, "manager may create a bill", ALLOW,
        () => setDoc(doc(mgr, "invoices", "ZZ-MGR"), { status: "pending", amount: 80 }));

    await expect(B, "manager records a payment as provisional", ALLOW,
        () => updateDoc(doc(mgr, "invoices", "ZZ-PENDING"), {
            status: "provisional", recordedBy: "mgr", recordedAt: ts,
            receiptNumber: "RCP-PROBE", paymentMethod: "cash",
        }));
    await expect(B, "recording cannot also change the amount", DENY,
        () => updateDoc(doc(mgr, "invoices", "ZZ-PAID"), {
            status: "provisional", recordedBy: "mgr", recordedAt: ts, amount: 9999,
        }));
    await expect(B, "manager cannot verify a payment", DENY,
        () => updateDoc(doc(mgr, "invoices", "ZZ-PROV-MGR"), verify("mgr", { selfVerified: true })));
    await expect(B, "manager cannot forge a treasurer's uid", DENY,
        () => updateDoc(doc(mgr, "invoices", "ZZ-PROV-MGR"), verify("tre")));
    await expect(B, "treasurer cannot verify without a bank reference", DENY,
        () => updateDoc(doc(tre, "invoices", "ZZ-PROV-MGR"), {
            status: "paid", verification: "verified", verifiedBy: "tre",
            verifiedAt: ts, selfVerified: false,
        }));
    await expect(B, "treasurer cannot verify with a 2-character note", DENY,
        () => updateDoc(doc(tre, "invoices", "ZZ-PROV-MGR"), verify("tre", { verifyNote: "ok" })));
    await expect(B, "treasurer verifies someone else's recording", ALLOW,
        () => updateDoc(doc(tre, "invoices", "ZZ-PROV-MGR"), verify("tre")));
    await expect(B, "treasurer cannot verify their own recording", DENY,
        () => updateDoc(doc(tre, "invoices", "ZZ-PROV-TRE"), verify("tre", { selfVerified: true })));
    await expect(B, "super_admin may self-verify, flagged as such", ALLOW,
        () => updateDoc(doc(sup, "invoices", "ZZ-PROV-SUP"), verify("sup", { selfVerified: true })));
    await expect(B, "treasurer cannot skip pending → paid", DENY,
        () => updateDoc(doc(tre, "invoices", "ZZ-PENDING"), verify("tre")));
    await expect(B, "a verified row cannot be un-verified", DENY,
        () => updateDoc(doc(tre, "invoices", "ZZ-PAID"), { status: "provisional" }));
    await expect(B, "manager cannot void", DENY,
        () => updateDoc(doc(mgr, "invoices", "ZZ-PAID"), {
            status: "void", voidReason: "probe", voidedBy: "mgr", voidedAt: ts,
        }));
    await expect(B, "treasurer cannot void", DENY,
        () => updateDoc(doc(tre, "invoices", "ZZ-PAID"), {
            status: "void", voidReason: "probe", voidedBy: "tre", voidedAt: ts,
        }));
    await expect(B, "super_admin voids with a reason", ALLOW,
        () => updateDoc(doc(sup, "invoices", "ZZ-PAID"), {
            status: "void", voidReason: "duplicate receipt", voidedBy: "sup", voidedAt: ts,
        }));
}

/* ── 4. payment_events: append-only, bound to the caller ──────────────────── */
await seed(testEnv);
{
    const B = "4. payment_events";
    let created = null;
    await expect(B, "committee appends an audit event", ALLOW, async () => {
        created = await addDoc(collection(mgr, "payment_events"), {
            invoiceId: "ZZ-PENDING", action: "recorded", by: "mgr", at: ts,
        });
        return created;
    });
    await expect(B, "an event cannot claim another user's uid", DENY,
        () => addDoc(collection(mgr, "payment_events"), {
            invoiceId: "ZZ-PENDING", action: "recorded", by: "tre", at: ts,
        }));
    await expect(B, "an event's timestamp must be a timestamp", DENY,
        () => addDoc(collection(mgr, "payment_events"), {
            invoiceId: "ZZ-PENDING", action: "recorded", by: "mgr", at: "2026-10-27",
        }));
    await expect(B, "anonymous cannot append an event", DENY,
        () => addDoc(collection(anon, "payment_events"), {
            invoiceId: "ZZ-PENDING", action: "recorded", by: "x", at: ts,
        }));
    await expect(B, "an event cannot be edited", DENY,
        () => updateDoc(created, { action: "tampered" }));
    await expect(B, "an event cannot be deleted", DENY,
        () => deleteDoc(created));
    await expect(B, "anonymous cannot read the audit trail", DENY,
        () => getDoc(created));
    await expect(B, "committee can read the audit trail", ALLOW,
        () => getDoc(doc(mgr, "payment_events", created.id)));
}

/* ── 5. admin_accounts: super_admin only, and self-read for role discovery ── */
await seed(testEnv);
{
    const B = "5. admin_accounts";
    await expect(B, "a signed-in user may read their own admin doc", ALLOW,
        () => getDoc(doc(stranger, "admin_accounts", "stranger")));
    await expect(B, "a signed-in non-admin cannot read another's", DENY,
        () => getDoc(doc(stranger, "admin_accounts", "tre")));
    await expect(B, "committee may read any admin doc", ALLOW,
        () => getDoc(doc(mgr, "admin_accounts", "tre")));
    await expect(B, "anonymous cannot read admin docs", DENY,
        () => getDoc(doc(anon, "admin_accounts", "tre")));
    await expect(B, "a non-admin cannot grant themselves a role", DENY,
        () => setDoc(doc(stranger, "admin_accounts", "stranger"), { role: "super_admin" }));
    await expect(B, "a manager cannot grant a role", DENY,
        () => setDoc(doc(mgr, "admin_accounts", "mgr2"), { role: "super_admin" }));
    await expect(B, "super_admin may grant a role", ALLOW,
        () => setDoc(doc(sup, "admin_accounts", "mgr2"), { name: "NEW", role: "manager" }));
}

/* ── 6. resident-facing read-mostly collections ───────────────────────────── */
await seed(testEnv);
{
    const B = "6. settings / news / stats / chat";
    await expect(B, "anonymous reads taman_config", ALLOW,
        () => getDoc(doc(anon, "settings", "taman_config")));
    await expect(B, "anonymous cannot write taman_config", DENY,
        () => setDoc(doc(anon, "settings", "taman_config"), { monthlyFee: 1 }));
    await expect(B, "manager writes taman_config", ALLOW,
        () => setDoc(doc(mgr, "settings", "taman_config"), { monthlyFee: 80 }));

    await expect(B, "anonymous reads announcements", ALLOW,
        () => getDoc(doc(anon, "announcements", "a1")));
    await expect(B, "anonymous cannot post an announcement", DENY,
        () => setDoc(doc(anon, "announcements", "a1"), { title: "fake" }));
    await expect(B, "manager posts an announcement", ALLOW,
        () => setDoc(doc(mgr, "announcements", "a1"), { title: "real" }));

    await expect(B, "anonymous reads monthly stats", ALLOW,
        () => getDoc(doc(anon, "stats_monthly", "2026-10")));
    await expect(B, "anonymous cannot write monthly stats", DENY,
        () => setDoc(doc(anon, "stats_monthly", "2026-10"), { paid: 1 }));

    await expect(B, "anonymous may post to community chat", ALLOW,
        () => addDoc(collection(anon, "community_chat"), { text: "hello" }));
    await expect(B, "anonymous cannot delete a chat message", DENY,
        () => deleteDoc(doc(anon, "community_chat", "c1")));
}

/* ── 7. visits: the visitorsEnabled flag is a database gate, not a hidden button */
await seed(testEnv, { visitors: true });
{
    const B = "7. visits — module toggle";
    await expect(B, "module ON: anonymous may create a pass", ALLOW,
        () => setDoc(doc(anon, "visits", "ZZ-NEW"), { name: "Guest", status: "active" }));
    await expect(B, "anonymous cannot delete a pass", DENY,
        () => deleteDoc(doc(anon, "visits", "ZZ-V")));
    await expect(B, "manager deletes a pass", ALLOW,
        () => deleteDoc(doc(mgr, "visits", "ZZ-V")));
}
await seed(testEnv, { visitors: false });
{
    const B = "7. visits — module toggle";
    await expect(B, "module OFF: anonymous cannot create a pass", DENY,
        () => setDoc(doc(anon, "visits", "ZZ-NEW"), { name: "Guest", status: "active" }));
    await expect(B, "module OFF: an existing pass is still cancellable", ALLOW,
        () => updateDoc(doc(anon, "visits", "ZZ-V"), { status: "cancelled" }));
    await expect(B, "module OFF: reads still work", ALLOW,
        () => getDoc(doc(anon, "visits", "ZZ-V")));
}
await seed(testEnv);
{
    const B = "7. visits — module toggle";
    await expect(B, "module flag absent: treated as ON", ALLOW,
        () => setDoc(doc(anon, "visits", "ZZ-NEW"), { name: "Guest", status: "active" }));
}

/* ---------------------------------------------------------------------- report */
await testEnv.cleanup();

let block = "";
for (const r of rows) {
    if (r.block !== block) {
        block = r.block;
        console.log(`\n${block}`);
    }
    const got = r.pass ? "" : `   <- got ${r.got}, want ${r.want}`;
    console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.label}${got}`);
}

const total = rows.length;
const passed = total - failed - harnessErrors;
console.log(`\n${passed}/${total} rules assertions passed`
    + (failed ? ` · ${failed} rule failure(s)` : "")
    + (harnessErrors ? ` · ${harnessErrors} HARNESS ERROR(s)` : ""));

if (harnessErrors) {
    console.log("\nA harness error is not a denial. Fix the probe before trusting this run.");
}
if (failed || harnessErrors) {
    console.log("RULES ARE WRONG — see FAIL rows above (firestore.rules vs tests/rules.test.mjs)");
    process.exit(1);
}
console.log("firestore.rules behaves as specified");
process.exit(0);
