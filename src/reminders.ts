import {
  listAllAgents,
  listLeads,
  responsiveness,
  setPipeline,
  type Lead,
  type Pipeline,
} from "./store.js";
import { notifyAgent } from "./notify.js";

// Only auto-demote a silent lead to no_reply from these early/neutral stages.
// Never clobber a stage the agent set deliberately (eoi/deal_closed/waste) or
// re-mark one already there.
const AUTO_NOREPLY_FROM: ReadonlySet<Pipeline> = new Set<Pipeline>([
  "new",
  "qualifies",
  "details_sent",
]);

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

/** One agent's stale-lead digest: find stale leads, auto-demote silent ones, and
 *  DM that agent (their send_number) one digest. Returns the digest or null. */
async function runAgentReminders(agentId: string, sendNumber: string): Promise<string | null> {
  const leads = await listLeads(agentId);

  const states: LeadState[] = [];
  for (const lead of leads) {
    const r = await responsiveness(agentId, lead.id);
    states.push({ lead, last_direction: r.last_direction, silent_ms: r.silent_ms });

    // Auto-demote to no_reply once the lead has gone silent past the store's
    // 24h window, but only from an early/neutral stage — never overwrite an
    // agent-set eoi/deal_closed/waste, and skip leads already at no_reply.
    if (r.state === "no_reply" && AUTO_NOREPLY_FROM.has(lead.pipeline)) {
      await setPipeline(agentId, lead.id, "no_reply");
    }
  }

  const digest = buildDigest(selectStale(states));
  if (digest) await notifyAgent(sendNumber, digest);
  return digest;
}

/**
 * Daily follow-up: run the stale-lead digest for EVERY registered agent, each sent
 * to its own send_number. Each agent only ever hears about their own leads. Returns
 * a per-agent map of the digest sent (null = nothing stale), for observability.
 * One agent's failure doesn't sink the others.
 * ponytail: single digest per agent, not N messages; per-lead if the agent asks.
 */
export async function runDailyReminders(): Promise<Map<string, string | null>> {
  const agents = await listAllAgents();
  const results = new Map<string, string | null>();
  for (const agent of agents) {
    try {
      results.set(agent.agent_id, await runAgentReminders(agent.agent_id, agent.send_number));
    } catch (e) {
      console.error(`[reminders] ${agent.agent_id} failed:`, e);
      results.set(agent.agent_id, null);
    }
  }
  return results;
}
