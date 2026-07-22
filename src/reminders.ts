import { listLeads, responsiveness, type Lead } from "./store.js";
import { notifyAgent } from "./notify.js";

const AGENT_ID = process.env.AGENT_ID ?? "agent_demo";

// Tunables. A lead is "stale" once the agent's last message has gone unanswered
// this long — longer than the store's 24h QUIET_MS, which only marks "no_reply".
// The digest is sent once per this cadence.
const STALE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
export const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

// The per-lead responsiveness read, paired with its lead. What selectStale filters.
export interface LeadState {
  lead: Lead;
  last_direction: "in" | "out" | null;
  silent_ms: number | null;
}

/**
 * Pick leads the agent messaged that have gone quiet > STALE_MS (last direction
 * "out", lead never replied), oldest-quiet first — the ball is in the agent's
 * court on these. A lead whose last message was inbound (the lead is waiting on
 * the agent) is a different, fresher signal and is out of scope here.
 * Pure: takes the already-read states so it's testable without a store.
 */
export function selectStale(states: LeadState[]): { lead: Lead; silentMs: number }[] {
  return states
    .filter((s) => s.last_direction === "out" && s.silent_ms !== null && s.silent_ms > STALE_MS)
    .map((s) => ({ lead: s.lead, silentMs: s.silent_ms as number }))
    .sort((a, b) => b.silentMs - a.silentMs);
}

// "Ahmed (JVC · 2BR) — 4 days quiet" — enough for the agent to place the lead.
function line(lead: Lead, silentMs: number): string {
  const who = lead.name ? lead.name : lead.phone;
  const tag = [lead.area, lead.requirement].filter(Boolean).join(" · ");
  const days = Math.floor(silentMs / (24 * 60 * 60 * 1000));
  return `${who}${tag ? ` (${tag})` : ""} — ${days} days quiet`;
}

/** One digest naming the stale leads, or null when none are stale. Pure. */
export function buildDigest(stale: { lead: Lead; silentMs: number }[]): string | null {
  if (stale.length === 0) return null;
  const n = stale.length;
  return (
    `${n} lead${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} a nudge:\n` +
    stale.map((s) => `• ${line(s.lead, s.silentMs)}`).join("\n")
  );
}

/**
 * Find the stale leads and DM the agent one digest naming them so they can chase.
 * Returns the digest sent, or null when nothing is stale (no message sent).
 * ponytail: single digest, not N messages; per-lead if the agent asks.
 */
export async function runDailyReminders(): Promise<string | null> {
  const leads = await listLeads(AGENT_ID);

  const states: LeadState[] = [];
  for (const lead of leads) {
    const r = await responsiveness(AGENT_ID, lead.id);
    states.push({ lead, last_direction: r.last_direction, silent_ms: r.silent_ms });
  }

  const digest = buildDigest(selectStale(states));
  if (digest) await notifyAgent(digest);
  return digest;
}
