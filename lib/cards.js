/* Access-card logic for TamanGuard — pure functions, no DOM, no Firestore.
 *
 * A card is three stored facts:
 *     blocked      true | false            (manual, admin only, overrides everything)
 *     activatedAt  "YYYY-MM-DD" | null     (written ONCE, when the card is handed over)
 *     expiresAt    "YYYY-MM-DD" | null     (activatedAt + 1 year, then +1 year per renewal)
 *
 * Everything the UI shows — ACTIVE / EXPIRING / EXPIRED / UNUSED / BLOCKED — is derived
 * from those three, so a status can never drift out of sync with the dates.
 *
 * Expiry is NEVER inferred from "last seen at the gate". A card in a drawer still expires.
 */

export const CARD_FEES = { new: 50, renewal: 20 };
export const EXPIRING_DAYS = 30;

/* Serials are compared and stored in one shape: uppercase, no spaces or dots.
   "a4f2 19c8" and "A4F2-19C8" must never become two cards for the same plastic. */
export function normaliseSerial(raw) {
    return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isValidSerial(raw) {
    const s = normaliseSerial(raw);
    return s.length >= 6 && s.length <= 24;
}

/* "A4F21 9C8" -> "A4F2-19C8" for display only. Stored value stays normalised. */
export function formatSerial(raw) {
    const s = normaliseSerial(raw);
    if (s.length === 8) return `${s.slice(0, 4)}·${s.slice(4)}`;
    if (s.length === 10) return `${s.slice(0, 4)}·${s.slice(4, 8)}·${s.slice(8)}`;
    return s;
}

export function todayISO(now = Date.now()) {
    const d = new Date(now);
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* Add one calendar year, clamping 29 Feb to 28 Feb on a non-leap target year. */
export function addYear(iso) {
    if (!iso) return null;
    const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
    const target = y + 1;
    const leap = (target % 4 === 0 && target % 100 !== 0) || target % 400 === 0;
    const day = m === 2 && d === 29 && !leap ? 28 : d;
    const p = n => String(n).padStart(2, "0");
    return `${target}-${p(m)}-${p(day)}`;
}

export function daysBetween(fromISO, toISO) {
    if (!fromISO || !toISO) return null;
    const a = new Date(`${String(fromISO).slice(0, 10)}T00:00:00`);
    const b = new Date(`${String(toISO).slice(0, 10)}T00:00:00`);
    return Math.round((b - a) / 86400000);
}

export function daysLeft(card, now = Date.now()) {
    if (!card || !card.expiresAt) return null;
    return daysBetween(todayISO(now), card.expiresAt);
}

/* The one function every screen asks. Order matters: blocked beats everything,
 * then "never activated", then the dates. */
export function effectiveStatus(card, now = Date.now()) {
    if (!card) return "unknown";
    if (card.blocked) return "blocked";
    if (!card.activatedAt || !card.expiresAt) return "unused";
    const left = daysLeft(card, now);
    if (left < 0) return "expired";
    if (left <= EXPIRING_DAYS) return "expiring";
    return "active";
}

export const STATUS_LABEL = {
    active: "ACTIVE", expiring: "EXPIRING", expired: "EXPIRED",
    unused: "UNUSED", blocked: "BLOCKED", unknown: "UNKNOWN",
};

export function statusTone(status) {
    return {
        active: "emerald", expiring: "amber", expired: "slate",
        unused: "indigo", blocked: "rose",
    }[status] || "slate";
}

/* Activating starts the clock. Returns null if it is already running — activating twice
   must never extend a period for free. */
export function activationPatch(card, now = Date.now()) {
    if (!card || card.activatedAt) return null;
    const start = todayISO(now);
    return { activatedAt: start, expiresAt: addYear(start), status: "active" };
}

/* Renewal adds twelve months to the period that is already running, so renewing early
   never loses a day. A card that ran out renews from today, not from its old expiry. */
export function renewalPatch(card, now = Date.now()) {
    const today = todayISO(now);
    const running = card && card.expiresAt ? card.expiresAt : null;
    const base = running && running > today ? running : today;
    const to = addYear(base);
    return { activatedAt: (card && card.activatedAt) || today, expiresAt: to, status: "active", from: running, to };
}

export function feeFor(kind) {
    return CARD_FEES[kind] === undefined ? null : CARD_FEES[kind];
}

export function receiptNo(now = Date.now()) {
    return `RCP-${now}`;
}

/* Summary line for a house: how many cards, and the worst state among them — used as the
 * badge on the resident row so the list needs no extra reads. */
export function houseSummary(cards, now = Date.now()) {
    const live = (cards || []).filter(c => c);
    const rank = { blocked: 0, expired: 1, expiring: 2, unused: 3, active: 4 };
    let worst = null;
    live.forEach(c => {
        const s = effectiveStatus(c, now);
        if (worst === null || rank[s] < rank[worst]) worst = s;
    });
    return { count: live.length, status: worst };
}
