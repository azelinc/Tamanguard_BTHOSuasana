/* Statement-import engine tests — invented register, no resident data.
 *
 * Names are deliberately coded (ALPHA ZULU, PAPA QUEBEC) rather than realistic: an
 * earlier version used plausible Malaysian names and one of them, paired with a real
 * house number, reproduced an actual household in this estate. This file is served
 * publicly by GitHub Pages, so the fixture must be unable to name anyone.
 *
 * Shapes and edge cases come from the Sept 2026 Maybank statement: address written
 * into the remark, payer name truncated with '*', one house at RM60, and the same
 * credit arriving twice when statement periods overlap.
 */
import assert from "node:assert/strict";
import {
  normaliseRef, money, fingerprint, parseAddress, indexRegister, rateOf, allocate,
  classify, reconcile, summarise, suggestByName, STATE, BASIS, REASON,
} from "../lib/verify-import.js";

const H = (road, unit, name, payRef, soaRate = 80) => ({ road, unitNumber: unit, name, payRef, soaRate });

const REGISTER = [
  H("Jalan Suasana 5/3", "1", "ALPHA ZULU", "53-001"),
  H("Jalan Suasana 5/3", "5", "BRAVO CHARLIE BIN DELTA", "53-005"),
  H("Jalan Suasana 5/3", "15", "BRAVO CHARLIE DELTA", "53-015"),
  H("Jalan Suasana 5/3", "47", "ECHO FOXTROT GOLF", "53-047"),
  H("Jalan Suasana 5/3A", "40", "HOTEL BIN INDIA", "53A-040"),
  H("Jalan Suasana 3/1", "1", "JULIET BIN KILO", "31-001"),
  H("Jalan Suasana 3/1A", "43", "LIMA MIKE", "31A-043", 60),
  H("Jalan Suasana 3/1B", "5", "NOVEMBER OSCAR", "31B-005"),
  H("Jalan Suasana 3/1C", "18", "PAPA QUEBEC", "31C-018"),
  H("Jalan Suasana 5/1", "3", "ROMEO SIERRA", "51-003"),
  H("Jalan Suasana 5/2", "14", "TANGO UNIFORM", "52-014"),
  H("Jalan Suasana 5/2C", "15", "VICTOR WHISKEY", "52C-015"),
  /* two households holding an identical name — the only case that truly ties */
  H("Jalan Suasana 5/3", "30", "XRAY YANKEE", "53-030"),
  H("Jalan Suasana 5/3", "60", "XRAY YANKEE", "53-060"),
];

const index = indexRegister(REGISTER);
const MONTHS = ["2026-08", "2026-09", "2026-10", "2026-11", "2026-12"];
const ctx = (seen = new Set()) => ({ index, outstandingFor: () => MONTHS, seen });

/* a credit the way Maybank prints it: date, desc, amount, then up to 3 detail lines */
const line = (date, amount, ...details) => ({ date, amount, desc: "TRANSFER TO A/C", details });

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n        ${e.message.split("\n").slice(0, 3).join("\n        ")}`); }
};

/* ---- address fragments, as they actually appear ---- */
t("parseAddress reads the three real-world shapes", () => {
  assert.deepEqual(parseAddress("5 S3/1b"), { street: "3/1B", unit: "5" });
  assert.deepEqual(parseAddress("28 jln suasana 5/3"), { street: "5/3", unit: "28" });
  assert.deepEqual(parseAddress("43, jln Susana 3/1C."), { street: "3/1C", unit: "43" });
  assert.equal(parseAddress("11 Jalan Suasa"), null);      // no street number — unusable
});

t("a pay ref beats an address when both are present", () => {
  const r = classify(line("01/09", 80, "NOVEMBER OSCAR *", "5 S3/1b", "52C-015"), ctx());
  assert.equal(r.basis, BASIS.REF);
  assert.equal(r.house.payRef, "52C-015");
});

/* ---- the signals that actually carry today's file ---- */
t("street + unit in the remark resolves deterministically", () => {
  const r = classify(line("01/09", 80, "NOVEMBER OSCAR   *", "5 S3/1b", "MBB CT-"), ctx());
  assert.equal(r.state, STATE.MATCHED);
  assert.equal(r.basis, BASIS.ADDRESS);
  assert.equal(r.confidence, "confirmed");
  assert.equal(r.house.payRef, "31B-005");
  assert.deepEqual(r.alloc.months, ["2026-08"]);
});

t("a unique payer name resolves, but only as a proposal", () => {
  const r = classify(line("02/09", 240, "PAPA QUEBEC *", "MBB CT-"), ctx());
  assert.equal(r.state, STATE.MATCHED);
  assert.equal(r.basis, BASIS.NAME);
  assert.equal(r.confidence, "proposed");       // must be ticked by a human
  assert.equal(r.house.payRef, "31C-018");
  assert.equal(r.alloc.count, 3);
});

t("two households with the same name neither wins — a human decides", () => {
  const r = classify(line("03/09", 80, "XRAY YANKEE"), ctx());
  assert.equal(r.state, STATE.NEEDS_LOOK);
  assert.equal(r.reason, REASON.NAME_TIED);
  assert.equal(r.candidates.length, 2);
  assert.equal(r.house, undefined);
});

t("a single shared token is never proposed as a match", () => {
  // Thin name hits inflated the first pass to 73% on the real file; each one would
  // have credited a wrong house if auto-ticked.
  const r = classify(line("03/09", 80, "ZULU ONLY"), ctx());
  assert.equal(r.state, STATE.NEEDS_LOOK);
  assert.equal(r.reason, REASON.NAME_WEAK);
  assert.equal(r.house, undefined);
});

t("an unknown payer with no address is left alone", () => {
  const r = classify(line("04/09", 80, "KEDAI TUJUH SDN BHD"), ctx());
  assert.equal(r.state, STATE.NO_REF);
  assert.equal(r.house, undefined);
});

t("a ref to a house that does not exist is flagged, not guessed", () => {
  const r = classify(line("05/09", 80, "TRF 53-999"), ctx());
  assert.equal(r.state, STATE.NEEDS_LOOK);
  assert.equal(r.reason, REASON.UNKNOWN_REF);
});

/* ---- the RM60 house ---- */
t("RM60 from the RM60 house buys exactly one month", () => {
  const r = classify(line("06/09", 60, "LIMA MIKE *", "43 jln suasana 3/1A"), ctx());
  assert.equal(r.state, STATE.MATCHED);
  assert.equal(r.rate, 60);
  assert.equal(r.alloc.count, 1);
  assert.equal(r.alloc.leftover, 0);
});

t("RM60 against an RM80 house buys nothing and says so", () => {
  const r = classify(line("06/09", 60, "ALPHA ZULU"), ctx());
  assert.equal(r.state, STATE.NEEDS_LOOK);
  assert.equal(r.reason, REASON.BELOW_ONE_MONTH);
});

t("a part-month overpayment is flagged with the exact shortfall", () => {
  const r = classify(line("06/09", 100, "ALPHA ZULU"), ctx());
  assert.equal(r.reason, REASON.AMOUNT_NOT_MULTIPLE);
  assert.equal(r.alloc.count, 1);
  assert.equal(r.alloc.leftover, 20);
});

/* ---- allocation ---- */
t("money past the last unbilled month becomes an advance", () => {
  const a = allocate(400, 80, MONTHS.slice(0, 2));
  assert.equal(a.count, 2);
  assert.equal(a.advance, 240);
  assert.equal(a.leftover, 0);
});

t("floor division never rounds a short payment into a month", () => {
  assert.equal(allocate(79.99, 80, MONTHS).count, 0);
  assert.equal(allocate(239, 80, MONTHS).count, 2);
});

/* ---- duplicates, exclusions ---- */
t("the same credit twice is marked already and credits nothing", () => {
  const l = line("07/09", 80, "ALPHA ZULU", "1 jln suasana 5/3");
  assert.equal(classify(l, ctx()).state, STATE.MATCHED);
  assert.equal(classify(l, ctx(new Set([fingerprint(l)]))).state, STATE.ALREADY);
});

t("two different payers on the same day for the same amount are NOT duplicates", () => {
  /* Every Maybank credit is described "TRANSFER TO A/C", so a fingerprint built from
     date+amount+desc alone collides: the real Sept file produced 14 false "already
     applied" hits and silently dropped RM1,200. The details lines must be part of it. */
  const a = line("01/09", 80, "ALPHA ZULU *", "Guard Ogos 26");
  const b = line("01/09", 80, "ECHO FOXTROT GOLF *", "28 jln suasana 5/3");
  assert.notEqual(fingerprint(a), fingerprint(b));
  const seen = new Set([fingerprint(a)]);
  assert.equal(classify(a, ctx(seen)).state, STATE.ALREADY);
  assert.notEqual(classify(b, ctx(seen)).state, STATE.ALREADY);
});

t("an exclusion keeps its reason", () => {
  const r = classify({ ...line("08/09", 40, "BANK CHG REVERSAL"), excludeReason: "not a security fee" }, ctx());
  assert.equal(r.state, STATE.EXCLUDED);
  assert.equal(r.note, "not a security fee");
});

/* ---- the invariant ---- */
t("the five buckets add back to the statement total to the sen", () => {
  const results = [
    line("01/09", 80, "NOVEMBER OSCAR *", "5 S3/1b"),        // address
    line("02/09", 240, "PAPA QUEBEC *"),                     // name
    line("03/09", 80, "XRAY YANKEE"),                        // tied
    line("04/09", 80, "KEDAI TUJUH SDN BHD"),                // nothing
    { ...line("08/09", 40, "BANK CHG REVERSAL"), excludeReason: "not a fee" },
  ].map(l => classify(l, ctx()));
  const rec = reconcile(results, 520);
  assert.equal(rec.balanced, true);
  assert.equal(rec.counted, 520);
  assert.equal(rec.buckets[STATE.MATCHED], 320);
});

t("a line missing from the parse makes the month unclosable", () => {
  const results = [line("01/09", 80, "NOVEMBER OSCAR *", "5 S3/1b")].map(l => classify(l, ctx()));
  const rec = reconcile(results, 160);
  assert.equal(rec.balanced, false);
  assert.equal(rec.diff, -80);
});

/* ---- summary the tab shows ---- */
t("summarise separates confirmed from proposed", () => {
  const results = [
    line("01/09", 80, "NOVEMBER OSCAR *", "5 S3/1b"),   // address → confirmed
    line("02/09", 240, "PAPA QUEBEC *"),                // name → proposed
    line("04/09", 80, "KEDAI TUJUH SDN BHD"),           // nothing
  ].map(l => classify(l, ctx()));
  const s = summarise(results);
  assert.equal(s.matchedLines, 2);
  assert.equal(s.confirmedLines, 1);
  assert.equal(s.proposedLines, 1);
  assert.equal(s.humanLines, 1);
});

/* ---- every house reachable by its pay ref, should one ever arrive ---- */
t("every house resolves when the ref is used", () => {
  let n = 0;
  for (const h of REGISTER) {
    const r = classify(line("09/09", h.soaRate, `DUITNOW TRF ${h.payRef} ${h.name}`), ctx());
    if (r.state === STATE.MATCHED && r.house.payRef === h.payRef) n++;
  }
  assert.equal(n, REGISTER.length);
});

t("ref normalisation tolerates case and spacing variants", () => {
  assert.equal(normaliseRef("31a-011a"), "31A-011A");
  assert.equal(normaliseRef("  52C - 015 "), "52C-015");
  assert.equal(normaliseRef("ACCT 51402231 123456789012"), null);
});

console.log(`\n${pass} passed, ${fail} failed · invented register ${REGISTER.length} houses`);
process.exit(fail ? 1 : 0);
