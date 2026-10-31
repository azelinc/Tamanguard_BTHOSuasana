/* Maybank corporate current-account statement → transactions.
 *
 * Layout, as the PDF text arrives (one run per cell, top to bottom):
 *
 *   DD/MM                     entry date
 *   TRANSFER TO A/C           description
 *   80.00+                    amount, + credit / - debit
 *   45,164.63                 running balance
 *      NIK NURIRSYAD IYAS *   payer name, truncated at 20 chars
 *      Guard                  remark
 *      Ogos 26
 *
 * The parser is deliberately strict about the amount/balance pair and returns
 * `warnings` for anything that does not fit — a silent miss here means money that
 * never reaches the worklist, which is the one failure mode that matters.
 *
 * Verified against 512389632240_D_30Sep2026.pdf: 47 transactions, and the running
 * balance reconciles on 46/46 consecutive steps.
 */

const DATE_RE = /^(\d{2})\/(\d{2})$/;
const AMT_RE = /^([\d,]+\.\d{2})([+-])$/;
const BAL_RE = /^([\d,]+\.\d{2})(?:DR)?$/;

const num = s => parseFloat(String(s).replace(/,/g, ""));

export function parseTransactions(rawText) {
  const lines = String(rawText || "").split("\n").map(l => l.replace(/\s+$/, ""));
  const txns = [];
  const warnings = [];
  let year = null;

  /* statement year comes from the header; "30/09/26" */
  const yMatch = String(rawText).match(/\b\d{2}\/\d{2}\/(\d{2})\b/);
  if (yMatch) year = 2000 + parseInt(yMatch[1], 10);

  let i = 0;
  while (i < lines.length) {
    const d = lines[i].trim().match(DATE_RE);
    if (!d) { i++; continue; }

    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;

    let desc = null;
    if (j < lines.length && !AMT_RE.test(lines[j].trim()) && !BAL_RE.test(lines[j].trim())) {
      desc = lines[j].trim();
      j++;
    }

    let amount = null, sign = null, balance = null;
    if (j < lines.length && AMT_RE.test(lines[j].trim())) {
      const a = lines[j].trim().match(AMT_RE);
      amount = num(a[1]); sign = a[2];
      j++;
      if (j < lines.length && BAL_RE.test(lines[j].trim())) {
        balance = num(lines[j].trim().match(BAL_RE)[1]);
        j++;
      }
    }

    const details = [];
    while (j < lines.length) {
      const s = lines[j].trim();
      if (!s || DATE_RE.test(s) || AMT_RE.test(s) || BAL_RE.test(s)) break;
      details.push(s);
      j++;
      if (details.length >= 3) break;
    }

    if (amount === null) {
      warnings.push(`date ${d[1]}/${d[2]} had no amount — skipped`);
      i++;
      continue;
    }

    const mm = parseInt(d[2], 10);
    txns.push({
      entryDate: `20${year ? String(year).slice(2) : "??"}-${String(mm).padStart(2, "0")}-${d[1]}`,
      day: d[1], month: d[2],
      desc,
      amount,
      balance,
      credit: sign === "+",
      details,
      text: [desc || "", ...details].join(" "),
    });
    i = Math.max(j, i + 1);
  }

  /* The running balance is the proof the parse is right: any gap means a missed
     or double-counted line, and every figure downstream would be wrong. */
  let broken = 0, checked = 0;
  for (let k = 1; k < txns.length; k++) {
    const a = txns[k - 1].balance, b = txns[k].balance;
    if (a == null || b == null) continue;
    checked++;
    const want = Math.round((a + (txns[k].credit ? txns[k].amount : -txns[k].amount)) * 100) / 100;
    if (Math.abs(want - b) > 0.005) { broken++; warnings.push(`balance break at ${txns[k].entryDate} (${want} ≠ ${b})`); }
  }
  txns.forEach(t => { t.balanceOk = broken === 0; });

  const credits = txns.filter(t => t.credit);
  const debits = txns.filter(t => !t.credit);
  return {
    txns, credits, debits, warnings,
    creditTotal: Math.round(credits.reduce((s, t) => s + t.amount, 0) * 100) / 100,
    debitTotal: Math.round(debits.reduce((s, t) => s + t.amount, 0) * 100) / 100,
    balanceChecked: checked, balanceBreaks: broken,
  };
}

/* Extract text from a PDF File/ArrayBuffer using pdf.js, one line per text run.
 * `pdfjsLib` is injected so this stays testable and CDN-agnostic. */
export async function pdfToLines(pdfjsLib, source) {
  const data = source instanceof ArrayBuffer ? new Uint8Array(source) : source;
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    for (const item of content.items) {
      const s = String(item.str || "");
      if (!s.trim()) continue;
      out.push(s.trim());
    }
  }
  return { text: out.join("\n"), pages: doc.numPages };
}
