/* Position maths for TamanGuard — pure functions, no DOM, no Firestore.
 *
 * Spark-tier budget is 50k document reads/day, so the app must never scan the
 * invoice collection to answer "how much does this estate owe". Two sources,
 * resolved in this order:
 *
 *   1. the resident's cached aggregate (soaCharged / soaPaid / soaBalance /
 *      soaAdvance) — written whenever bills are generated or a payment is taken
 *   2. the invoice ledger, when the caller already holds it in memory
 *
 * Both come from the same arithmetic below, so a cached figure and a live figure
 * can never disagree by more than an unwritten update.
 */

export function indexInvoices(invoices) {
    const map = new Map();
    (invoices || []).forEach(i => {
        const k = `${i.road}|${i.unitNumber}`;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(i);
    });
    return map;
}

/* Aggregate a house's ledger into the fields cached on the resident document. */
export function aggregate(invoices) {
    let charged = 0, paid = 0, paidCount = 0, pending = 0, pendingCount = 0;
    (invoices || []).forEach(i => {
        const a = parseFloat(i.amount) || 0;
        charged += a;
        if (i.status === "paid") { paid += a; paidCount++; }
        // recorded by a committee member, not yet confirmed by the Treasurer
        else if (i.status === "provisional") { pending += a; pendingCount++; }
    });
    return { soaCharged: charged, soaPaid: paid, soaBalance: charged - paid, soaBills: (invoices || []).length, soaPaidCount: paidCount, soaPending: pending, soaPendingCount: pendingCount };
}

/* Position for one house. Pass `invoices` + `index` when the ledger is in memory,
 * otherwise the cached aggregate on the resident document is used (no reads). */
export function position(res, invoices, index) {
    const idx = index || (invoices ? indexInvoices(invoices) : null);
    const held = idx ? (idx.get(`${res.road}|${res.unitNumber}`) || []) : null;
    const advance = Number(res.soaAdvance || 0);
    const hasLedger = !!(held && held.length);
    const agg = hasLedger ? aggregate(held) : null;

    const charged = agg ? agg.soaCharged : Number(res.soaCharged || 0);
    const paid = agg ? agg.soaPaid : Number(res.soaPaid || 0);
    const bills = agg ? agg.soaBills : Number(res.soaBills || 0);
    const paidCount = agg ? agg.soaPaidCount : Number(res.soaPaidCount || 0);
    const pending = agg ? agg.soaPending : Number(res.soaPending || 0);
    const pendingCount = agg ? agg.soaPendingCount : Number(res.soaPendingCount || 0);

    return {
        charged, paid, advance, pending, pendingCount,
        balance: charged - paid - advance,
        // what is genuinely still owed once recorded-but-unverified money is set aside
        stillDue: Math.max(0, charged - paid - pending),
        bills, paidCount,
        liveCharged: charged, livePaid: paid, liveCount: bills,
        openCharged: 0, openPaid: 0,
        itemised: charged > 0 || bills > 0,
        openingAsOf: res.soaOpeningAsOf || null,
        source: hasLedger ? "ledger" : (charged ? "cache" : "none")
    };
}

export function portfolio(residents, invoices, index) {
    const idx = invoices ? (index || indexInvoices(invoices)) : null;
    let charged = 0, paid = 0, pending = 0, arrears = 0, credit = 0;
    let paidCount = 0, pendingCount = 0;
    let debtors = 0, creditors = 0, settled = 0, withOpening = 0, itemised = 0;

    (residents || []).forEach(r => {
        const p = position(r, invoices, idx);
        charged += p.charged;
        paid += p.paid;
        pending += p.pending;
        paidCount += p.paidCount || 0;
        pendingCount += p.pendingCount || 0;
        if (p.itemised) itemised++;
        else if (p.openingAsOf) withOpening++;

        if (p.balance > 0.004) { arrears += p.balance; debtors++; }
        else if (p.balance < -0.004) { credit += -p.balance; creditors++; }
        else settled++;
    });

    const houses = (residents || []).length;
    return {
        charged, paid, pending, paidCount, pendingCount, net: charged - paid,
        /* money recorded but unverified is inside `arrears` until confirmed —
           `stillDue` is what is genuinely unpaid right now */
        stillDue: Math.max(0, charged - paid - pending),
        arrears, credit, debtors, creditors, settled,
        withOpening, itemised, houses,
        rate: charged > 0 ? (paid / charged) * 100 : 0
    };
}

/* Roads are named "Jalan Suasana 5/3", "Jalan Suasana 3/1A". The first number after
   "Suasana" is the area, so the grouping survives new roads being opened later
   (5/4 lands in the 5 group without a code change). Returns "" for anything that
   does not follow the pattern, and callers must not silently drop those. */
export function roadGroup(road) {
    const m = /Suasana\s+(\d+)/i.exec(String(road || ""));
    return m ? m[1] : "";
}

/* Group a resident list into area buckets, keeping any unparseable roads visible. */
export function groupTotals(residents, calc) {
    const out = {};
    residents.forEach(r => {
        const g = roadGroup(r.road) || "other";
        const t = out[g] || (out[g] = { houses: 0, charged: 0, paid: 0, pending: 0, stillDue: 0 });
        const v = calc(r);
        t.houses += 1;
        t.charged += v.charged; t.paid += v.paid; t.pending += v.pending;
        t.stillDue += v.stillDue;
    });
    return out;
}
