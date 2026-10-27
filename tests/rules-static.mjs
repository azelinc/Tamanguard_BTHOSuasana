#!/usr/bin/env node
/* Static guards on firestore.rules — zero dependencies, runs in ~30 ms.
 *
 *   node tests/rules-static.mjs
 *
 * These catch the two failure modes that made the 2026-10-26 rules bug invisible:
 *   1. a catch-all block that can write — Firestore ORs every matching rule, so one
 *      `allow ... write` at `/{document=**}` grants write on every path in the
 *      database and silently defeats every scoped rule above it;
 *   2. a collection the app writes to that has no `match` block of its own, so its
 *      only rule is the catch-all. Adding a collection must be a deliberate act.
 *
 * The dynamic matrix in rules.test.mjs proves behaviour; this proves coverage.
 */
import { readFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url).pathname;
const SOURCE = readFileSync(ROOT + "firestore.rules", "utf8");

/* Collections the client actually touches. Keep in sync with the grep in
 * tests/README.md when a new collection is added. */
const CLIENT_COLLECTIONS = [
    "admin_accounts", "announcements", "community_chat", "invoices",
    "payment_events", "residents", "settings", "stats_monthly", "visits",
];

/* Collections where a permissive write is a money-integrity defect. */
const MONEY_PATHS = ["invoices", "payment_events", "admin_accounts"];

let problems = 0;
const fail = (msg) => { problems++; console.log(`FAIL  ${msg}`); };
const pass = (msg) => console.log(`PASS  ${msg}`);

/* --- strip comments, then walk the match blocks by brace depth ---------------- */
const stripped = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

function blockAt(start) {
    let depth = 0;
    for (let i = start; i < stripped.length; i++) {
        if (stripped[i] === "{") depth++;
        else if (stripped[i] === "}") {
            depth--;
            if (depth === 0) return stripped.slice(start, i + 1);
        }
    }
    return stripped.slice(start);
}

/* Only top-level match blocks matter for path coverage: `settings/taman_config` is
 * a nested literal, not a wildcard collection. Take depth-1 matches only. */
const blocks = [];
{
    let depth = 0;
    const re = /(match\s+[^{]+)/g;
    let m;
    while ((m = re.exec(stripped))) {
        const open = stripped.indexOf("{", m.index);
        if (open === -1) continue;
        // count depth from the start of the file up to this match
        let d = 0;
        for (let i = 0; i < m.index; i++) {
            if (stripped[i] === "{") d++;
            else if (stripped[i] === "}") d--;
        }
        blocks.push({ header: m[1].trim(), depth: d, body: blockAt(open) });
    }
    void depth;
}

const top = blocks.filter((b) => b.depth === 1);
const byPath = new Map();
for (const b of top) {
    const mm = b.header.match(/match\s+\/([^/{\s]+)\//);
    const name = mm ? mm[1] : null;
    if (name && !byPath.has(name)) byPath.set(name, b);
}
const paths = [...byPath.keys()];

/* 1. the catch-all may read, never write ------------------------------------- */
const catchAlls = top.filter((b) => /\{document\s*=\s*\*\*\}/.test(b.header));
if (catchAlls.length === 0) {
    fail("no `/{document=**} ` catch-all found — path coverage cannot be reasoned about");
} else {
    for (const b of catchAlls) {
        const writes = [...b.body.matchAll(/allow\s+([^:]+):/g)]
            .map((m) => m[1])
            .filter((verbs) => /\b(write|create|update|delete)\b/.test(verbs));
        if (writes.length) {
            fail(`catch-all grants write (${writes.join(" · ")}) — it ORs over every scoped rule`);
        } else {
            pass("catch-all is read-only");
        }
    }
}

/* 2. every client collection has its own match block ------------------------- */
for (const name of CLIENT_COLLECTIONS) {
    if (paths.includes(name)) pass(`collection \`${name}\` has a scoped rule`);
    else fail(`collection \`${name}\` has no match block — only the catch-all covers it`);
}

/* 3. money paths are never writable without auth ----------------------------- */
for (const name of MONEY_PATHS) {
    const b = byPath.get(name);
    if (!b) continue;
    const open = [...b.body.matchAll(/allow\s+[^:]+:\s*if\s+([^;]+);/g)].map((m) => m[1].trim());
    const unguarded = open.filter((cond) => cond === "true" || /^true\s*(\|\||&&)/.test(cond));
    if (unguarded.length) fail(`\`${name}\` has an unauthenticated write rule: ${unguarded[0]}`);
    else pass(`\`${name}\` writes are gated`);
}

console.log(problems ? `\n${problems} rules-structure problem(s)` : "\nrules structure OK");
process.exit(problems ? 1 : 0);
