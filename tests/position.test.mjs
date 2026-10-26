/* Position maths — run with:  node tests/position.test.mjs
 * No dependencies, no Firestore: fixtures only. */
import { portfolio, indexInvoices, position, aggregate } from "../lib/position.js";

const R = (road, unit, extra = {}) => ({ road, unitNumber: unit, ...extra });
const I = (road, unit, status, amount = 80) => ({ road, unitNumber: unit, status, amount });

let failures = 0;
const assert = (label, got, want) => {
    const ok = Math.abs(got - want) < 0.005;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}: got ${got}, want ${want}`);
    if (!ok) failures++;
};

const residents = [
    R("A", "1"),                                                              // 24 unpaid bills
    R("A", "2", { soaAdvance: 240 }),                                         // 24 paid + RM240 advance
    R("B", "9", { soaCharged: 1760, soaPaid: 480, soaOpeningAsOf: "2026-10-31" }),
    R("C", "7"),                                                              // nothing at all
];

const invoices = [];
for (let y = 2025; y <= 2026; y++) {
    for (let m = 1; m <= 12; m++) {
        invoices.push(I("A", "1", "pending"));
        invoices.push(I("A", "2", "paid"));
    }
}
invoices.push(I("B", "9", "paid", 40));   // ledger exists -> must override the soa* opening figure

const idx = indexInvoices(invoices);

const p1 = position(residents[0], invoices, idx);
assert("A1 charged (24 x 80)", p1.charged, 1920);
assert("A1 nothing paid", p1.paid, 0);
assert("A1 balance", p1.balance, 1920);
assert("A1 itemised", p1.itemised ? 1 : 0, 1);

const p2 = position(residents[1], invoices, idx);
assert("A2 paid", p2.paid, 1920);
assert("A2 advance", p2.advance, 240);
assert("A2 balance is a credit", p2.balance, -240);

const p3 = position(residents[2], invoices, idx);
assert("B9 ledger overrides soa* opening", p3.itemised ? 1 : 0, 1);
assert("B9 charged", p3.charged, 40);
assert("B9 settled", p3.balance, 0);

const p4 = position(residents[3], invoices, idx);
assert("C7 no ledger, no opening", p4.charged + p4.paid + p4.balance, 0);

const t = portfolio(residents, invoices, idx);
assert("portfolio charged", t.charged, 1920 + 1920 + 40);
assert("portfolio paid", t.paid, 1920 + 40);
assert("portfolio debtors", t.debtors, 1);
assert("portfolio creditors", t.creditors, 1);
assert("portfolio arrears", t.arrears, 1920);
assert("portfolio credit", t.credit, 240);

// ---- cache path: no ledger in memory, figures come off the resident document ----
const cached = R("D", "1", { soaCharged: 1920, soaPaid: 480, soaAdvance: 0, soaBills: 24, soaPaidCount: 6 });
const pc = position(cached, null, null);
assert("cache source", pc.source === "cache" ? 1 : 0, 1);
assert("cache charged", pc.charged, 1920);
assert("cache balance", pc.balance, 1440);
assert("cache paid months", pc.paidCount, 6);

const agg = aggregate([I("E", "1", "paid"), I("E", "1", "paid"), I("E", "1", "pending")]);
assert("aggregate charged", agg.soaCharged, 240);
assert("aggregate paid", agg.soaPaid, 160);
assert("aggregate balance", agg.soaBalance, 80);
assert("aggregate bills", agg.soaBills, 3);

const cachedPortfolio = portfolio([cached], null, null);
assert("portfolio from cache, no invoices", cachedPortfolio.charged, 1920);
assert("portfolio cache arrears", cachedPortfolio.arrears, 1440);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
