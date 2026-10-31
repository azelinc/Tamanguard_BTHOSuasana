/* Statement-import engine tests — synthetic register, no resident data.
 *
 * The register is fake on purpose: this repo is served publicly and the real one
 * holds 341 neighbours' names. Shapes and edge cases are copied from the Sept 2026
 * Maybank statement (address in the remark, payer name truncated with '*', one
 * house at RM60, the same credit appearing twice when periods overlap).
 */
import assert from "node:assert/strict";
import {
  normaliseRef, money, fingerprint, parseAddress, indexRegister, rateOf, allocate,
  classify, reconcile, summarise, suggestByName, STATE, BASIS, REASON,
} from "../lib/verify-import.js";

const H = (road, unit, name, payRef, soaRate = 80) => ({ road, unitNumber: unit, name, payRef, soaRate });

const REGISTER = [
  H("Jalan Suasana 5/3", "1", "AHMAD ZAKARIA", "53-001"),
  H("Jalan Suasana 5/3", "5", "NURUL AIN BT ZULKIFLI", "53-005"),
  H("Jalan Suasana 5/3", "15", "NURUL AINI BT ZULKIFLI", "53-015"),
  H("Jalan Suasana 5/3", "47", "WONG YEE LING", "53-047"),
  H("Jalan Suasana 5/3A", "40", "HABSAH BT OMAR", "53A-040"),
  H("Jalan Suasana 3/1", "1", "IBRAHIM BIN HASSAN", "31-001"),
  H("Jalan Suasana 3/1A", "43", "ARUMUGAM VELOO", "31A-043", 60),
  H("Jalan Suasana 3/1B", "5", "TAN CHEE KONG", "31B-005"),
  H("Jalan Suasana 3/1C", "18", "SIEW LUP YAN", "31C-018"),
  H("Jalan Suasana 5/1", "3", "RAJESH KUMAR", "51-003"),
  H("Jalan Suasana 5/2", "14", "LAM WAI LOK", "52-014"),
  H("Jalan Suasana 5/2C", "15", "LEE CHONG WEI", "52C-015"),
  /* two households with an identical name — the only case that truly ties */
  H("Jalan Suasana 5/3", "30", "MOHD FAIZAL BIN RAMLI", "53-030"),
  H("Jalan Suasana 5/3", "60", "MOHD FAIZAL BIN RAMLI", "53-060"),
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
  const r = classify(line("01/09", 80, "TAN CHEE KONG *", "5 S3/1b", "52C-015"), ctx());
  assert.equal(r.basis, BASIS.REF);
  assert.equal(r.house.payRef, "52C-015");
});

/* ---- the signals that actually carry today's file ---- */
t("street + unit in the remark resolves deterministically", () => {
  const r = classify(line("01/09", 80, "TAN CHEE KONG      *", "5 S3/1b", "MBB CT-"), ctx());
  assert.equal(r.state, STATE.MATCHED);
  assert.equal(r.basis, BASIS.ADDRESS);
  assert.equal(r.confidence, "confirmed");
  assert.equal(r.house.payRef, "31B-005");
  assert.deepEqual(r.alloc.months, ["2026-08"]);
});

t("a unique payer name resolves, but only as a proposal", () => {
  const r = classify(line("02/09", 240, "SIEW LUP YAN    *", "MBB CT-"), ctx());
  assert.equal(r.state, STATE.MATCHED);
  assert.equal(r.basis, BASIS.NAME);
  assert.equal(r.confidence, "proposed");       // must be ticked by a human
  assert.equal(r.house.payRef, "31C-018");
  assert.equal(r.alloc.count, 3);
});

t("two households with the same name neither wins — a human decides", () => {
  const r = classify(line("03/09", 80, "MOHD FAIZAL BIN RAMLI"), ctx());
  assert.equal(r.state, STATE.NEEDS_LOOK);
  assert.equal(r.reason, REASON.NAME_TIED);
  assert.equal(r.candidates.length, 2);
  assert.equal(r.house, undefined);
});

t("a single shared token is never proposed as a match", () => {
  // "ZHENG" appears in one name; on the real statement 18 of 24 name hits were
  // this thin, and each would have credited the wrong house if auto-ticked.
  const r = classify(line("03/09", 80, "LEE FU ZHENG *"), ctx());
  assert.notEqual(r.state, STATE.MATCHED);
  assert.equal(r.state, STATE.NEEDS_LOOK);
  assert.equal(r.reason, REASON.NAME_WEAK);
});

t("an unknown payer with no address is left alone", () => {
  const r = classify(line("04/09", 80, "KEDAI LIMA SDN BHD"), ctx());
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
  const r = classify(line("06/09", 60, "ARUMUGAM VELOO *", "43 jln suasana 3/1A"), ctx());
  assert.equal(r.state, STATE.MATCHED);
  assert.equal(r.rate, 60);
  assert.equal(r.alloc.count, 1);
  assert.equal(r.alloc.leftover, 0);
});

t("RM60 against an RM80 house buys nothing and says so", () => {
  const r = classify(line("06/09", 60, "AHMAD ZAKARIA"), ctx());
  assert.equal(r.state, STATE.NEEDS_LOOK);
  assert.equal(r.reason, REASON.BELOW_ONE_MONTH);
});

t("a part-month overpayment is flagged with the exact shortfall", () => {
  const r = classify(line("06/09", 100, "AHMAD ZAKARIA"), ctx());
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
  const l = line("07/09", 80, "AHMAD ZAKARIA", "1 jln suasana 5/3");
  const first = classify(l, ctx());
  assert.equal(first.state, STATE.MATCHED);
  const second = classify(l, ctx(new Set([fingerprint(l)])));
  assert.equal(second.state, STATE.ALREADY);
});

t("an exclusion keeps its reason", () => {
  const r = classify({ ...line("08/09", 40, "BANK CHG REVERSAL"), excludeReason: "not a security fee" }, ctx());
  assert.equal(r.state, STATE.EXCLUDED);
  assert.equal(r.note, "not a security fee");
});

/* ---- the invariant ---- */
t("the five buckets add back to the statement total to the sen", () => {
  const results = [
    line("01/09", 80, "TAN CHEE KONG *", "5 S3/1b"),        // address
    line("02/09", 240, "SIEW LUP YAN *"),                    // name
    line("03/09", 80, "MOHD FAIZAL BIN RAMLI"),              // tied
    line("04/09", 80, "KEDAI LIMA SDN BHD"),                 // nothing
    { ...line("08/09", 40, "BANK CHG REVERSAL"), excludeReason: "not a fee" },
  ].map(l => classify(l, ctx()));
  const rec = reconcile(results, 520);
  assert.equal(rec.balanced, true);
  assert.equal(rec.counted, 520);
  assert.equal(rec.buckets[STATE.MATCHED], 320);
});

t("a line missing from the parse makes the month unclosable", () => {
  const results = [line("01/09", 80, "TAN CHEE KONG *", "5 S3/1b")].map(l => classify(l, ctx()));
  const rec = reconcile(results, 160);
  assert.equal(rec.balanced, false);
  assert.equal(rec.diff, -80);
});

/* ---- summary the tab shows ---- */
t("summarise separates confirmed from proposed", () => {
  const results = [
    line("01/09", 80, "TAN CHEE KONG *", "5 S3/1b"),   // address → confirmed
    line("02/09", 240, "SIEW LUP YAN *"),               // name → proposed
    line("04/09", 80, "KEDAI LIMA SDN BHD"),            // nothing
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

console.log(`\n${pass} passed, ${fail} failed · synthetic register ${REGISTER.length} houses`);
process.exit(fail ? 1 : 0);
