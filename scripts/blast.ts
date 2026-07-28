import "dotenv/config";
import { readFileSync } from "node:fs";
import { sendTemplate } from "../src/notify.js";
import { loadOptOuts } from "../src/optout.js";

/**
 * Quality-first campaign blast: send an approved MARKETING template to old funnel
 * leads from a CSV, from the company number, WITHOUT tanking the WABA quality
 * rating. The rating gates the messaging limit, and one careless blast to weeks-old
 * contacts is the classic way a High number gets Flagged - so every default here
 * favours the rating over speed:
 *   - opted-out numbers are skipped (compliance; ignoring STOP spikes blocks)
 *   - newest leads first (ramp: engage the freshest June leads before the stalest)
 *   - --limit N caps each run so you can watch the rating ~24h between batches
 *   - a 09:00-20:00 Dubai send window (off-hours sends get blocked more)
 *   - slow, sequential pacing (~1.5s/send) - nowhere near the 80/s API cap on purpose
 *   - one failed send never aborts the batch; a full summary makes re-runs diagnosable
 *
 *   npm run blast -- ./leads.csv --template june_inquiry_followup --lang en --dry-run
 *   npm run blast -- ./leads.csv --template june_inquiry_followup --lang en --limit 200
 *
 * ponytail: fixed delay + sequential loop, in-file batching by --limit. Fine for a
 * few hundred leads. Add concurrency/backoff only if lists reach thousands AND the
 * rating holds. Re-running re-sends earlier rows - split the CSV per batch or track
 * where you are; there's no per-number "already sent" ledger (send-only by design).
 */

export interface Row {
  phone: string; // E.164 digits, no +
  name: string;
  inquiryDate: string; // raw cell — drives the newest-first sort AND shown as {{2}}
  source: string; // where the lead came from — shown as {{3}}
}

/** Digits only - tolerate a leading + or spaces in the CSV. */
function digitsOnly(n: string): string {
  return String(n).replace(/\D/g, "");
}

/** Split one CSV line on commas. ponytail: no quoted-field handling - a name with a
 *  comma would split wrong. Real names here don't; add a parser lib only if they do. */
function splitLine(line: string): string[] {
  return line.split(",").map((c) => c.trim());
}

/**
 * Parse CSV text into rows. Expects a header with `phone` (required) and optional
 * `name` / `inquiry_date` / `source` columns, matched by name so column order
 * doesn't matter. Drops rows with no valid phone. Pure - no I/O, no network.
 * Exported for the test.
 */
export function parseCsv(text: string): Row[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return [];
  const header = splitLine(lines[0]).map((h) => h.toLowerCase());
  const iPhone = header.indexOf("phone");
  const iName = header.indexOf("name");
  const iDate = header.indexOf("inquiry_date");
  const iSource = header.indexOf("source");
  if (iPhone < 0) throw new Error('CSV must have a "phone" column');

  const rows: Row[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitLine(line);
    const phone = digitsOnly(cells[iPhone] ?? "");
    if (!/^\d{6,15}$/.test(phone)) continue; // drop blank / malformed
    rows.push({
      phone,
      name: (iName >= 0 ? cells[iName] : "") ?? "",
      inquiryDate: (iDate >= 0 ? cells[iDate] : "") ?? "",
      source: (iSource >= 0 ? cells[iSource] : "") ?? "",
    });
  }
  return rows;
}

/**
 * The full pre-send pipeline as pure logic: sort newest-first (ramp), drop opted-out
 * numbers, dedup repeat phones, then cap to `limit`. Returns the sendable rows plus
 * the counts the summary needs. Exported for the test - this is the quality-critical
 * ordering/filtering, so it's the thing worth a self-check.
 */
export function prepareBlast(
  rows: Row[],
  optOuts: Set<string>,
  limit: number,
): { toSend: Row[]; skippedOptOut: number; skippedDup: number } {
  // Newest inquiry first. Empty/unparseable dates sort last (treated as time 0).
  const ts = (d: string) => {
    const t = Date.parse(d);
    return Number.isNaN(t) ? 0 : t;
  };
  const sorted = [...rows].sort((a, b) => ts(b.inquiryDate) - ts(a.inquiryDate));

  const seen = new Set<string>();
  let skippedOptOut = 0;
  let skippedDup = 0;
  const eligible: Row[] = [];
  for (const r of sorted) {
    if (optOuts.has(r.phone)) {
      skippedOptOut++;
      continue;
    }
    if (seen.has(r.phone)) {
      skippedDup++;
      continue;
    }
    seen.add(r.phone);
    eligible.push(r);
  }
  const toSend = limit > 0 ? eligible.slice(0, limit) : eligible;
  return { toSend, skippedOptOut, skippedDup };
}

/** Current hour in Asia/Dubai (the WABA's timezone), 0-23. Marketing sends outside
 *  09:00-20:00 get blocked more, so the CLI refuses off-hours unless --force. */
function dubaiHour(): number {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Dubai",
    hour: "2-digit",
    hour12: false,
  }).format(new Date());
  return Number(s) % 24; // "24" (midnight) -> 0
}

function getArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SEND_GAP_MS = 1500; // deliberately slow - protect the rating, not race the cap
// Template variable fallbacks. A WhatsApp template variable CANNOT be empty — a
// blank value fails the whole send, so every {{n}} must resolve to non-empty text.
// Name is the only field that's actually blank sometimes, but date/source get
// fallbacks too so a stray empty cell never breaks a send.
const NAME_FALLBACK = "there"; // "Hi there, ..."
const DATE_FALLBACK = "June 2026"; // "...you made on June 2026..."
const SOURCE_FALLBACK = "La Capitale"; // "...via La Capitale..." (only if source is blank)

async function main() {
  const args = process.argv.slice(2);
  const template = getArg(args, "--template");
  const lang = getArg(args, "--lang") ?? "en";
  const limit = Number(getArg(args, "--limit") ?? 0);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");

  // The one positional arg is the CSV path. Exclude flag *values* (the token after a
  // known value-flag) so `--template foo` doesn't get mistaken for the path.
  const valueFlags = ["--template", "--lang", "--limit"];
  const path = args.find((a, i) => !a.startsWith("--") && !valueFlags.includes(args[i - 1]));
  if (!path || !template) {
    console.error(
      "usage: npm run blast -- <csv> --template <name> [--lang en] [--limit N] [--dry-run] [--force]",
    );
    process.exit(1);
    return;
  }

  const hour = dubaiHour();
  if ((hour < 9 || hour >= 20) && !dryRun && !force) {
    console.error(
      `Refusing to send at ${hour}:00 Dubai - outside the 09:00-20:00 marketing window ` +
        `(off-hours sends get blocked more, hurting quality). Use --force to override.`,
    );
    process.exit(1);
    return;
  }

  const rows = parseCsv(readFileSync(path, "utf8"));
  const optOuts = loadOptOuts();
  const { toSend, skippedOptOut, skippedDup } = prepareBlast(rows, optOuts, limit);

  console.log(
    `Loaded ${rows.length} rows - ${skippedOptOut} opted-out - ${skippedDup} duplicate - ` +
      `sending ${toSend.length}${limit > 0 ? ` (capped at ${limit})` : ""}` +
      `${dryRun ? " - DRY RUN" : ""}`,
  );

  let sent = 0;
  const failures: { phone: string; error: string }[] = [];
  for (const [i, r] of toSend.entries()) {
    // {{1}}=name {{2}}=date {{3}}=source — order must match the approved template.
    // Blank cells fall back so no variable is ever empty (an empty var fails the send).
    const params = [
      r.name || NAME_FALLBACK,
      r.inquiryDate || DATE_FALLBACK,
      r.source || SOURCE_FALLBACK,
    ];
    if (dryRun) {
      console.log(
        `  [dry] -> ${r.phone}  {{1}}=${params[0]} {{2}}=${params[1]} {{3}}=${params[2]}` +
          `${r.name ? "" : " [name fallback]"}`,
      );
      continue;
    }
    try {
      await sendTemplate(r.phone, template, lang, params);
      sent++;
      if (sent % 25 === 0 || i === toSend.length - 1) {
        console.log(`  sent ${sent}/${toSend.length}...`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 131049 = per-user marketing frequency cap. Not a hard failure - just skip
      // this number; retrying within 24h won't help and only adds noise.
      failures.push({ phone: r.phone, error: msg });
      console.warn(`  ! ${r.phone} failed: ${msg}`);
    }
    if (i < toSend.length - 1) await sleep(SEND_GAP_MS);
  }

  console.log(
    `\nDone. sent ${sent}, failed ${failures.length}, ` +
      `skipped(optout) ${skippedOptOut}, skipped(dup) ${skippedDup}.`,
  );
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  ${f.phone}: ${f.error}`);
  }
  if (!dryRun && sent > 0) {
    console.log(
      "\n[!] Watch the quality rating in the 360dialog dashboard for ~24h. If it drops " +
        "to Medium/Red, STOP - do not run the next batch until it recovers to High.",
    );
  }
}

// Only run when invoked as the CLI entry point, so the test can import parseCsv /
// prepareBlast without firing a real blast. process.argv[1] is the executed script.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("blast.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
