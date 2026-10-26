#!/usr/bin/env node
/* Guard against reintroducing unbounded Firestore reads.
 *
 * Run: node tests/no-unbounded-reads.mjs
 *
 * A read that scans a whole collection is the failure mode that took this project
 * off the air on Spark (8,184 reads per Analytics tab open). Any such read must be
 * deliberate, so it has to carry an `allow-full-read: <reason>` marker on the line
 * itself or the line above. Everything else must filter (`where`) or cap (`limit`).
 */
import { readFileSync } from "node:fs";

const FILES = ["app.js", "resident.html", "statement.html", "admin/index.html"];
const ROOT = new URL("../", import.meta.url).pathname;

const READ_CALL = /(getDocs|onSnapshot)\s*\(\s*(collection\s*\(|query\s*\(\s*collection\s*\()/;
const BOUNDED = /\b(where|limit|startAfter|orderBy\s*\([^)]*\)\s*,\s*limit)\b/;

let problems = 0;

for (const file of FILES) {
    const lines = readFileSync(ROOT + file, "utf8").split("\n");
    lines.forEach((line, i) => {
        if (!READ_CALL.test(line)) return;
        // gather the full call, which may span lines
        let call = line, j = i;
        while (j < lines.length && !/\)\s*;?\s*$/.test(lines[j]) && j - i < 8) {
            j++;
            call += " " + (lines[j] || "");
        }
        if (BOUNDED.test(call)) return;
        const context = (lines[i - 1] || "") + line;
        if (/allow-full-read/.test(context)) return;
        problems++;
        console.log(`${file}:${i + 1}  unbounded read — no where/limit and no allow-full-read marker`);
        console.log(`   ${line.trim().slice(0, 110)}`);
    });
}

if (problems) {
    console.log(`\n${problems} unbounded read(s). Either bound the query or annotate it:`);
    console.log("   // allow-full-read: <why this is safe>");
    process.exit(1);
}
console.log(`no unbounded reads in ${FILES.length} files`);
