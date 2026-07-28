import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Campaign opt-out ledger. Marketing templates MUST honour opt-outs — a lead who
 * replies STOP (or taps the opt-out button) must never be sent to again, or blocks
 * climb and the WABA quality rating drops. This is the compliance-critical store.
 *
 * ponytail: a flat file (one E.164 per line) — durable, survives restarts, trivially
 * auditable, no schema migration. Fine for one campaign + one agent. Promote to a
 * Supabase table when opt-out must be honoured across multiple campaigns/agents.
 */

// Repo-root-relative so the script (cwd = repo root) and the server agree on one file.
const OPTOUT_PATH = path.resolve(process.cwd(), "campaign", "optout.txt");

/** Digits only — a stored/looked-up number must match regardless of + or spaces. */
function digitsOnly(n: string): string {
  return String(n).replace(/\D/g, "");
}

/** Every opted-out number as a Set (digits only). Missing file → empty set. */
export function loadOptOuts(): Set<string> {
  if (!existsSync(OPTOUT_PATH)) return new Set();
  const lines = readFileSync(OPTOUT_PATH, "utf8").split(/\r?\n/);
  const out = new Set<string>();
  for (const line of lines) {
    const d = digitsOnly(line);
    if (d) out.add(d);
  }
  return out;
}

/** Record an opt-out. Idempotent — already-listed numbers aren't appended twice.
 *  Creates campaign/ + the file on first use. Returns true if newly added. */
export function addOptOut(phone: string): boolean {
  const d = digitsOnly(phone);
  if (!d) return false;
  if (loadOptOuts().has(d)) return false;
  mkdirSync(path.dirname(OPTOUT_PATH), { recursive: true });
  appendFileSync(OPTOUT_PATH, d + "\n");
  return true;
}
