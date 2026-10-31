/* Statement-import matching engine — pure functions, no Firebase, no DOM.
 *
 * WHAT THE BANK ACTUALLY GIVES US (measured on the Sept 2026 Maybank statement,
 * 45 credits): the house pay ref appears in ZERO of them. Residents write either
 * nothing, their name, or a fragment of their address. So the matcher works on
 * what is present today — address, then name — and treats the pay ref as a bonus
 * for the day residents start quoting it.
 *
 * Evidence for the order of signals, from that same file:
 *   street+unit in the remark   10 credits   (deterministic once parsed)
 *   unique payer name           15 credits   (proposed, needs a tick)
 *   name ties / unreadable      20 credits   (a human decides)
 *
 * Nothing here writes anything. It answers one question per line: which house, and
 * how many months does this money buy. The UI renders that; the writer applies it.
 *
 * Privacy: no resident data lives in this file or its tests. The register is passed
 * in at runtime; test fixtures are synthetic.
 */

/* 53-001 · 31A-011A · 52C-015 · 53A-018. One optional space either side of the
 * hyphen, because banks print all three variants. */
export const REF_RE = /\b(\d{2}[A-D]?)\s?-\s?(\d{3}[A-Z]?)\b/;

/* "5/3", "3/1C", "S3/1b" — a street token as residents write it. */
const STREET_RE = /(?:^|[^0-9A-Z])(?:S\s?)?([35])\/([1-3])\s?([A-D])?(?![0-9])/i;
const UNIT_LEAD_RE = /^\s*(?:NO\.?\s*)?(\d{1,3})\b/i;
const UNIT_ANY_RE = /\b(?:NO\.?|LOT|RUMAH)\s*(\d{1,3})\b/i;

export const STATE = {
  MATCHED: "matched",
  NEEDS_LOOK: "needs-look",
  NO_REF: "no-ref",
  ALREADY: "already",
  EXCLUDED: "excluded",
};

export const BASIS = { REF: "ref", ADDRESS: "address", NAME: "name", NONE: null };

export const REASON = {
  UNKNOWN_REF: "unknown-ref",
  AMOUNT_NOT_MULTIPLE: "amount-not-multiple",
  BELOW_ONE_MONTH: "below-one-month",
  NOTHING_OUTSTANDING: "nothing-outstanding",
  NAME_TIED: "name-tied",
  NAME_WEAK: "name-weak",
  ALREADY_SEEN: "already-seen",
  NOT_A_FEE: "not-a-fee",
};

/* Trimmed and optionally truncated by the bank ("NURUL AIN BT ZULKI*"). */
const NAME_STOP = new Set([
  "BIN", "BINTI", "BT", "ABD", "ABDUL", "MOHD", "MOHAMAD", "MUHAMMAD", "MD",
  "HAJI", "HJ", "PN", "MR", "MRS", "MS", "DR", "JLN", "JALAN", "SUASANA",
  "SUSANA", "SUASA", "MBB", "TRANSFER", "FUND", "SECURITY", "GUARD",
  "BAYARAN", "YURAN", "MAINTENANCE", "AKAUN", "A/C",
]);

export function money(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function normaliseRef(text) {
  const m = String(text == null ? "" : text).toUpperCase().match(REF_RE);
  return m ? `${m[1]}-${m[2]}` : null;
}

/* Dedupe key: banks let you download overlapping periods, so the same credit WILL
 * arrive twice. No bank-side id exists in the PDF, so date+amount+description is it. */
export function fingerprint(line) {
  return [
    String(line.date || "").trim(),
    money(line.amount).toFixed(2),
    String(line.desc || "").toUpperCase().replace(/\s+/g, " ").trim(),
  ].join("|");
}

/* Address fragment → {street:"5/3", unit:"1"} | null.
 * The unit is the number in the same line as the street token when there is one,
 * otherwise the leading number of the remark ("28 jln suasana 5/3"). */
export function parseAddress(text) {
  const src = String(text || "");
  const m = src.match(STREET_RE);
  if (!m) return null;
  const street = `${m[1]}/${m[2]}${(m[3] || "").toUpperCase()}`;
  for (const line of src.split("\n")) {
    if (!STREET_RE.test(line)) continue;
    const u = line.replace(/\*/g, "").trim().match(UNIT_LEAD_RE);
    if (u) return { street, unit: u[1] };
  }
  const any = src.match(UNIT_ANY_RE);
  if (any) return { street, unit: any[1] };
  const lead = src.replace(/\*/g, "").trim().match(UNIT_LEAD_RE);
  return lead ? { street, unit: lead[1] } : { street, unit: null };
}

export function rateOf(house, fallbackRate = 80) {
  const r = Number(house && house.soaRate);
  return Number.isFinite(r) && r > 0 ? r : fallbackRate;
}

/* Oldest-unpaid-first: a credit clears arrears before it buys anything ahead.
 * `outstanding` is ascending ["2026-08","2026-09",...]. */
export function allocate(amount, rate, outstanding) {
  const total = money(amount);
  const r = money(rate);
  const months = Math.floor((total + 1e-9) / r);
  const leftover = money(total - months * r);
  const list = Array.isArray(outstanding) ? outstanding : [];
  const applied = months <= list.length ? list.slice(0, months) : list.slice();
  const advanceMonths = Math.max(0, months - list.length);
  return {
    months: applied,
    count: applied.length,
    leftover,
    advanceMonths,
    advance: money(advanceMonths * r),
    clean: leftover === 0 && months >= 1,
  };
}

function nameTokens(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/).filter(t => t.length >= 3 && !NAME_STOP.has(t) && !/^\d+$/.test(t));
}

/* Build the lookup tables once per import. */
export function indexRegister(residents) {
  const byRef = new Map();
  const byAddr = new Map();
  const rows = [];
  for (const r of residents || []) {
    const ref = normaliseRef(r.payRef);
    if (ref && !byRef.has(ref)) byRef.set(ref, r);
    const street = String(r.road || "").replace(/^Jalan Suasana\s*/i, "").replace(/\s+/g, "").toUpperCase();
    if (street && r.unitNumber != null) byAddr.set(`${street}|${String(r.unitNumber).toUpperCase()}`, r);
    rows.push({ house: r, toks: new Set(nameTokens(r.name)) });
  }
  return { byRef, byAddr, rows };
}

/* Candidates only — never a decision. Two households here differ by one letter. */
export function suggestByName(text, index, limit = 3) {
  const toks = new Set(nameTokens(text));
  if (!toks.size) return { tied: false, candidates: [] };
  const scored = [];
  for (const row of index.rows) {
    if (!row.toks.size) continue;
    const shared = [...toks].filter(t => row.toks.has(t));
    if (!shared.length) continue;
    scored.push({
      house: row.house,
      score: shared.length / Math.max(1, Math.min(toks.size, row.toks.size)),
      shared: shared.length,
      why: `name contains ${shared.join(" ")}`,
    });
  }
  scored.sort((a, b) => b.score - a.score || b.shared - a.shared);
  const top = scored[0];
  const tied = !!top && scored.filter(s => s.score === top.score && s.shared === top.shared)
    .some(s => s.house !== top.house);
  return {
    tied,
    candidates: scored.slice(0, limit).map(({ house, why, score, shared }) => ({ house, reason: why, score, shared })),
  };
}

/* Classify one credit.
 * ctx = { index, outstandingFor(house), seen:Set, rate? }
 * Returns state + basis + confidence ('confirmed' | 'proposed' | null). */
export function classify(line, ctx) {
  const amount = money(line.amount);
  const fp = fingerprint(line);
  const base = { ...line, amount, fingerprint: fp };
  const index = ctx.index;
  const text = [line.desc, ...(line.details || [])].join("\n");

  if (line.excludeReason) {
    return { ...base, state: STATE.EXCLUDED, reason: REASON.NOT_A_FEE, note: line.excludeReason, confidence: null };
  }
  if (ctx.seen && ctx.seen.has(fp)) {
    return { ...base, state: STATE.ALREADY, reason: REASON.ALREADY_SEEN, confidence: null };
  }

  /* 1. pay ref — the ideal path, currently unused by payers but honoured when present. */
  let house = null, basis = BASIS.NONE, ref = normaliseRef(line.ref || text);
  if (ref) {
    const hit = index.byRef.get(ref);
    if (hit) { house = hit; basis = BASIS.REF; }
    else if (!parseAddress(text)) {
      const { candidates } = suggestByName(text, index);
      return { ...base, state: STATE.NEEDS_LOOK, ref, reason: REASON.UNKNOWN_REF, candidates, confidence: null };
    }
  }

  /* 2. street + unit written into the remark — deterministic when both are present. */
  if (!house) {
    const addr = parseAddress(text);
    if (addr && addr.unit) {
      const hit = index.byAddr.get(`${addr.street}|${addr.unit}`);
      if (hit) { house = hit; basis = BASIS.ADDRESS; }
    }
  }

  /* 3. payer name — a proposal for a human, never a confirmation. */
  let nameCandidates = [];
  if (!house) {
    const { tied, candidates } = suggestByName(text, index);
    nameCandidates = candidates;
    const top = candidates[0];
    /* Two independent tokens, or nothing. On the real statement 18 of 24 name
       matches rested on one token ("ZHENG", "AZROL", "HARIS") — those are not a
       household, so they are offered as candidates instead of being proposed. */
    if (top && !tied && top.shared >= 2 && top.score >= 0.6) {
      house = top.house;
      basis = BASIS.NAME;
    } else if (candidates.length && tied) {
      return { ...base, state: STATE.NEEDS_LOOK, reason: REASON.NAME_TIED, candidates, confidence: null };
    }
  }

  if (!house) {
    const state = nameCandidates.length ? STATE.NEEDS_LOOK : STATE.NO_REF;
    const reason = nameCandidates.length ? REASON.NAME_WEAK : null;
    return { ...base, state, ref, reason, candidates: nameCandidates, confidence: null };
  }

  const rate = rateOf(house, ctx.rate);
  const outstanding = ctx.outstandingFor ? ctx.outstandingFor(house) : [];
  const alloc = allocate(amount, rate, outstanding);
  const confidence = basis === BASIS.NAME ? "proposed" : "confirmed";

  if (alloc.leftover > 0) {
    const reason = amount < rate ? REASON.BELOW_ONE_MONTH : REASON.AMOUNT_NOT_MULTIPLE;
    return { ...base, state: STATE.NEEDS_LOOK, ref, house, basis, rate, reason, alloc, confidence };
  }
  if (alloc.count === 0 && alloc.advanceMonths === 0) {
    return { ...base, state: STATE.NEEDS_LOOK, ref, house, basis, rate, reason: REASON.NOTHING_OUTSTANDING, alloc, confidence };
  }
  return { ...base, state: STATE.MATCHED, ref, house, basis, rate, alloc, confidence };
}

/* The audit invariant: buckets must add back to what the bank says came in. */
export function reconcile(lines, statementTotal) {
  const buckets = {};
  let counted = 0;
  for (const l of lines) {
    buckets[l.state] = money((buckets[l.state] || 0) + money(l.amount));
    counted = money(counted + money(l.amount));
  }
  const expected = money(statementTotal);
  const diff = money(counted - expected);
  return {
    buckets,
    counted,
    expected,
    diff,
    creditLines: lines.length,
    balanced: diff === 0,
    verdict: diff === 0
      ? `balances to ${expected.toFixed(2)}`
      : `off by ${diff.toFixed(2)} — ${diff > 0 ? "over" : "under"} the statement`,
  };
}

/* What the UI shows above the table. */
export function summarise(results) {
  const by = {};
  for (const r of results) {
    const k = r.state;
    by[k] = by[k] || { lines: 0, amount: 0 };
    by[k].lines++;
    by[k].amount = money(by[k].amount + r.amount);
  }
  const auto = results.filter(r => r.state === STATE.MATCHED);
  const confirmed = auto.filter(r => r.confidence === "confirmed");
  const proposed = auto.filter(r => r.confidence === "proposed");
  return {
    by,
    matchedLines: auto.length,
    matchedAmount: money(auto.reduce((s, r) => s + r.amount, 0)),
    confirmedLines: confirmed.length,
    proposedLines: proposed.length,
    humanLines: results.length - auto.length,
  };
}
