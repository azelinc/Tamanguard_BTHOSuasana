/* Position maths for TamanGuard — pure functions, no DOM, no Firestore.
 *
 * A house's financial position is derived from ONE source of truth:
 *   1. its invoice ledger (itemised from Jan 2025 by the backfill), or
 *   2. the carried-forward opening position on residents.soa* when it has no bills.
 * Never both — backfilled invoices already include the history, so summing the
 * two double-counts.
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

export function position(res, invoices, index) {
    const idx = index || indexInvoices(invoices);
    const held = idx.get(`${res.road}|${res.unitNumber}`) || [];

    if (held.length) {
        let charged = 0, paid = 0, paidCount = 0;
        // money received for months not yet billed (coverage ran past the last bill)
        const advance = Number(res.soaAdvance || 0);
        held.forEach(i => {
            const a = parseFloat(i.amount) || 0;
            charged += a;
            if (i.status === "paid") { paid += a; paidCount++; }
        });
        return {
            openCharged: 0, openPaid: 0,
            liveCharged: charged, livePaid: paid, liveCount: held.length,
            charged, paid, advance, balance: charged - paid - advance,
            paidCount, bills: held.length,
            openingAsOf: null, itemised: true
        };
    }

    const openCharged = Number(res.soaCharged || 0);
    const openPaid = Number(res.soaPaid || 0);
    return {
        openCharged, openPaid,
        liveCharged: 0, livePaid: 0, liveCount: 0,
        charged: openCharged, paid: openPaid, advance: 0,
        balance: openCharged - openPaid,
        paidCount: 0, bills: 0,
        openingAsOf: res.soaOpeningAsOf || null, itemised: false
    };
}

export function portfolio(residents, invoices, index) {
    const idx = index || indexInvoices(invoices);
    let charged = 0, paid = 0, arrears = 0, credit = 0;
    let debtors = 0, creditors = 0, settled = 0, withOpening = 0, itemised = 0;

    (residents || []).forEach(r => {
        const p = position(r, invoices, idx);
        charged += p.charged;
        paid += p.paid;
        if (p.itemised) itemised++;
        else if (p.openingAsOf) withOpening++;

        if (p.balance > 0.004) { arrears += p.balance; debtors++; }
        else if (p.balance < -0.004) { credit += -p.balance; creditors++; }
        else settled++;
    });

    const houses = (residents || []).length;
    return {
        charged, paid, net: charged - paid,
        arrears, credit, debtors, creditors, settled,
        withOpening, itemised, houses,
        rate: charged > 0 ? (paid / charged) * 100 : 0
    };
}
