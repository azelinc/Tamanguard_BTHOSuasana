/* Access-card logic tests: node --test tests/cards.test.mjs  (or: node tests/cards.test.mjs) */
import assert from "node:assert/strict";
import {
    normaliseSerial, isValidSerial, formatSerial, addYear, daysLeft,
    effectiveStatus, activationPatch, renewalPatch, feeFor, houseSummary, todayISO,
} from "../lib/cards.js";

let pass = 0;
function ok(name, fn) { fn(); pass++; console.log("  ✓", name); }

console.log("normalising serials");
ok("spaces and dots collapse to one key", () =>
    assert.equal(normaliseSerial(" a4f2 19c8 "), "A4F219C8"));
ok("dashes too, so one plastic can never become two cards", () =>
    assert.equal(normaliseSerial("A4F2-19C8"), normaliseSerial("a4f2 19c8")));
ok("too short is rejected", () => assert.equal(isValidSerial("AB12"), false));
ok("normal length passes", () => assert.equal(isValidSerial("A4F2-19C8"), true));
ok("display form keeps the middot", () => assert.equal(formatSerial("A4F219C8"), "A4F2·19C8"));

console.log("one year, calendar-correct");
ok("plain date rolls to the same day next year", () =>
    assert.equal(addYear("2025-11-12"), "2026-11-12"));
ok("29 Feb clamps to 28 Feb on a non-leap year", () =>
    assert.equal(addYear("2028-02-29"), "2029-02-28"));
ok("29 Feb keeps 29 on a leap year", () =>
    assert.equal(addYear("2027-02-28"), "2028-02-28"));

console.log("status derivation");
const card = (o = {}) => ({ blocked: false, activatedAt: null, expiresAt: null, ...o });
const NOW = new Date("2026-10-30T10:00:00").getTime();
ok("no activation date = UNUSED", () => assert.equal(effectiveStatus(card(), NOW), "unused"));
ok("blocked beats a valid period", () =>
    assert.equal(effectiveStatus(card({ activatedAt: "2025-11-12", expiresAt: "2027-11-12", blocked: true }), NOW), "blocked"));
ok("comfortable period = ACTIVE", () =>
    assert.equal(effectiveStatus(card({ activatedAt: "2026-03-04", expiresAt: "2027-03-04" }), NOW), "active"));
ok("30 days or fewer = EXPIRING", () =>
    assert.equal(effectiveStatus(card({ activatedAt: "2025-11-19", expiresAt: "2026-11-19" }), NOW), "expiring"));
ok("day after expiry = EXPIRED", () =>
    assert.equal(effectiveStatus(card({ activatedAt: "2025-10-29", expiresAt: "2026-10-29" }), NOW), "expired"));
ok("expires today still counts as EXPIRING, not expired", () =>
    assert.equal(effectiveStatus(card({ activatedAt: "2025-10-30", expiresAt: "2026-10-30" }), NOW), "expiring"));

console.log("activation");
ok("activation starts a one-year period", () => {
    const p = activationPatch(card(), NOW);
    assert.equal(p.activatedAt, "2026-10-30");
    assert.equal(p.expiresAt, "2027-10-30");
    assert.equal(p.status, "active");
});
ok("activating twice never extends the period for free", () => {
    assert.equal(activationPatch(card({ activatedAt: "2026-01-01", expiresAt: "2027-01-01" }), NOW), null);
});

console.log("renewal");
ok("renewing early stacks onto the running expiry (no lost days)", () => {
    const p = renewalPatch(card({ activatedAt: "2026-01-01", expiresAt: "2026-12-01" }), NOW);
    assert.equal(p.expiresAt, "2027-12-01");
    assert.equal(p.from, "2026-12-01");
});
ok("renewing a lapsed card starts from today, not from the old expiry", () => {
    const p = renewalPatch(card({ activatedAt: "2024-01-01", expiresAt: "2025-01-01" }), NOW);
    assert.equal(p.expiresAt, "2027-10-30");
});
ok("renewing an unactivated card activates it today", () => {
    const p = renewalPatch(card(), NOW);
    assert.equal(p.activatedAt, "2026-10-30");
    assert.equal(p.expiresAt, "2027-10-30");
});

console.log("money");
ok("new card is RM50, renewal RM20", () => {
    assert.equal(feeFor("new"), 50);
    assert.equal(feeFor("renewal"), 20);
    assert.equal(feeFor("block"), null);
});

console.log("house summary");
ok("worst state wins, and the count is honest", () => {
    const cards = [
        { activatedAt: "2026-06-01", expiresAt: "2027-06-01" },              // active
        { activatedAt: "2025-11-01", expiresAt: "2026-11-05" },              // expiring
        { activatedAt: "2024-01-01", expiresAt: "2025-01-01", blocked: true },// blocked
    ];
    const s = houseSummary(cards, NOW);
    assert.equal(s.count, 3);
    assert.equal(s.status, "blocked");
});
ok("no cards = count 0", () => assert.deepEqual(houseSummary([], NOW), { count: 0, status: null }));

console.log("date helpers");
ok("daysLeft counts from today", () => assert.equal(daysLeft({ expiresAt: "2026-11-09" }, NOW), 10));
ok("todayISO is local, not UTC-shifted", () => assert.equal(todayISO(NOW), "2026-10-30"));

console.log(`\n${pass} assertions passed`);
