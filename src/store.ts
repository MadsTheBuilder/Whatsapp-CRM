import { createClient } from "@supabase/supabase-js";

// Supabase (Postgres) storage via the service-role key — server-side only, so
// it bypasses RLS and never touches the browser. agent_id lives on every row so
// the one-agent demo is already multi-tenant-shaped (CLAUDE.md). Schema lives in
// supabase/schema.sql; there is no local DB file.
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
}
const db = createClient(url, key, { auth: { persistSession: false } });

export type Stage = "first_contact" | "following_up" | "deep";

// Sales funnel stage — distinct from `stage` (conversation-depth, drives tone).
// Ordered as the columns render on the board.
export type Pipeline =
  | "new"
  | "no_reply"
  | "qualifies"
  | "details_sent"
  | "meeting_done"
  | "eoi"
  | "deal_closed"
  | "waste";

export const PIPELINES: Pipeline[] = [
  "new",
  "no_reply",
  "qualifies",
  "details_sent",
  "meeting_done",
  "eoi",
  "deal_closed",
  "waste",
];

// Human-readable labels (WhatsApp list rows, confirmation DMs). Titles ≤24 chars
// per the list-message row limit. Keep in sync with Pipeline.
export const PIPELINE_LABELS: Record<Pipeline, string> = {
  new: "New",
  no_reply: "No reply",
  qualifies: "Qualifies",
  details_sent: "Details sent",
  meeting_done: "Meeting done",
  eoi: "EOI",
  deal_closed: "Deal closed",
  waste: "Waste lead",
};

// Approval gate: a number the read-pipe sees is only processed once the agent
// opts it in. New numbers land 'pending'; the agent taps Yes/No to approve/reject.
export type Monitor = "pending" | "approved" | "rejected";

export interface Lead {
  id: number;
  agent_id: string;
  phone: string;
  lid: string | null; // opaque @lid contact id, learned from inbound; resolves outbound @lid
  name: string | null;
  stage: Stage;
  pipeline: Pipeline;
  monitor: Monitor;
  budget: string | null;
  area: string | null;
  requirement: string | null;
  deal_type: string | null;
  unit_type: string | null;
  beds: string | null;
  timeline: string | null;
  status: string;
  next_question: string | null;
  replies_json: string | null;
  summary: string | null;
  summary_upto: number;
  updated_at: string;
}

export interface Message {
  id: number;
  agent_id: string;
  lead_id: number;
  direction: "in" | "out";
  body: string;
  ts: string;
}

/** Look up a lead by phone, or undefined if this number has never been seen.
 *  The approval gate uses "undefined" to mean "brand-new number — prompt the agent". */
export async function findLeadByPhone(agentId: string, phone: string): Promise<Lead | undefined> {
  const { data } = await db
    .from("leads")
    .select("*")
    .eq("agent_id", agentId)
    .eq("phone", phone)
    .maybeSingle();
  return (data as Lead) ?? undefined;
}

/** Look up a lead by its opaque @lid, or undefined. Used for outbound @lid
 *  messages that carry no phone — the lead's lid was learned from an earlier
 *  inbound (which carries both lid + phone). */
export async function findLeadByLid(agentId: string, lid: string): Promise<Lead | undefined> {
  const { data } = await db
    .from("leads")
    .select("*")
    .eq("agent_id", agentId)
    .eq("lid", lid)
    .maybeSingle();
  return (data as Lead) ?? undefined;
}

/** Persist the learned lid on a lead, only while it's still null (never thrash a
 *  stored lid). Keyed by id; no-op if the lead already has one. */
export async function setLeadLid(agentId: string, id: number, lid: string): Promise<void> {
  const { error } = await db
    .from("leads")
    .update({ lid, updated_at: new Date().toISOString() })
    .eq("agent_id", agentId)
    .eq("id", id)
    .is("lid", null);
  if (error) throw error;
}

/** Create a lead in 'pending' so it's remembered as awaiting approval. `created`
 *  is true only when THIS call inserted the row — so the caller fires the approval
 *  prompt exactly once even if a concurrent message raced to the same phone (the
 *  loser hits the unique constraint, recovers the existing row, and created=false). */
export async function createPendingLead(
  agentId: string,
  phone: string,
  name?: string,
): Promise<{ lead: Lead; created: boolean }> {
  const { data, error } = await db
    .from("leads")
    .insert({ agent_id: agentId, phone, name: name ?? null }) // monitor defaults 'pending'
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      const existing = await findLeadByPhone(agentId, phone);
      if (existing) return { lead: existing, created: false };
    }
    throw error;
  }
  return { lead: data as Lead, created: true };
}

/** Delete a still-pending lead by phone. Used to roll back a pending row whose
 *  approval prompt failed to send, so the next message re-fires as a fresh
 *  sighting. Guarded on monitor='pending' — never removes an approved/rejected
 *  lead (its transcript/summary must survive). */
export async function deletePendingLead(agentId: string, phone: string): Promise<void> {
  await db
    .from("leads")
    .delete()
    .eq("agent_id", agentId)
    .eq("phone", phone)
    .eq("monitor", "pending");
}

/** Set a lead's approval state (agent tapped Yes/No). Returns false if no such
 *  pending lead exists (already decided, or number never prompted). */
export async function setMonitor(
  agentId: string,
  phone: string,
  monitor: Monitor,
): Promise<boolean> {
  const { data, error } = await db
    .from("leads")
    .update({ monitor, updated_at: new Date().toISOString() })
    .eq("agent_id", agentId)
    .eq("phone", phone)
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/** Move a lead to a funnel stage (dashboard drag/dropdown or WhatsApp `stage`
 *  command). Keyed by id. Returns false if no such lead — so the caller can tell
 *  the agent "no lead there" instead of silently succeeding. */
export async function setPipeline(
  agentId: string,
  id: number,
  pipeline: Pipeline,
): Promise<boolean> {
  const { data, error } = await db
    .from("leads")
    .update({ pipeline, updated_at: new Date().toISOString() })
    .eq("agent_id", agentId)
    .eq("id", id)
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

// Agent registry (supabase/schema.sql `agents`): maps each agent's read-number →
// { agent_id, send_number }. The receiving number on an inbound event selects the
// lane; this is the ONLY source of identity (no env fallback).
export interface Agent {
  agent_id: string;
  read_number: string;
  send_number: string;
  name: string | null;
}

/** Digits only — strip a stray '+' / spaces so equality-matching a phone can't
 *  silently miss. Numbers are stored and matched as bare E.164 digits. */
function digitsOnly(n: string): string {
  return String(n).replace(/\D/g, "");
}

/** The lane a message arrived on: resolve the agent by the number the bot READS
 *  inbound on (display_phone_number for dialog360, the dev's own E.164 for
 *  baileys). undefined = unregistered number → the caller drops the message. */
export async function resolveAgentByReadNumber(readNumber: string): Promise<Agent | undefined> {
  const { data } = await db
    .from("agents")
    .select("agent_id, read_number, send_number, name")
    .eq("read_number", digitsOnly(readNumber))
    .maybeSingle();
  return (data as Agent) ?? undefined;
}

/** The asking agent on the company webhook: resolve by the number they text the
 *  bot FROM (their send_number). undefined = not a registered agent → drop. */
export async function resolveAgentBySendNumber(sendNumber: string): Promise<Agent | undefined> {
  const { data } = await db
    .from("agents")
    .select("agent_id, read_number, send_number, name")
    .eq("send_number", digitsOnly(sendNumber))
    .maybeSingle();
  return (data as Agent) ?? undefined;
}

/** Every registered agent, for per-agent iteration (the daily reminder digest). */
export async function listAllAgents(): Promise<Agent[]> {
  const { data, error } = await db
    .from("agents")
    .select("agent_id, read_number, send_number, name");
  if (error) throw error;
  return (data as Agent[]) ?? [];
}

/** Register an agent (POST /api/agents). Numbers are normalized to bare digits so
 *  the read/send equality lookups above always match. Throws on a duplicate
 *  agent_id or read_number (unique constraints). */
export async function registerAgent(a: {
  agent_id: string;
  read_number: string;
  send_number: string;
  name?: string;
}): Promise<Agent> {
  const { data, error } = await db
    .from("agents")
    .insert({
      agent_id: a.agent_id,
      read_number: digitsOnly(a.read_number),
      send_number: digitsOnly(a.send_number),
      name: a.name ?? null,
    })
    .select("agent_id, read_number, send_number, name")
    .single();
  if (error) throw error;
  return data as Agent;
}

export interface AgentSummary {
  agent_id: string;
  total: number;
  qualified: number; // qualifies + further down the funnel — leads worth working
  no_reply: number;
}

/** One row per agent with aggregate counts over approved leads, for the
 *  dashboard cards. For one agent it returns one row — correct. */
export async function listAgents(): Promise<AgentSummary[]> {
  const { data, error } = await db
    .from("leads")
    .select("agent_id, pipeline")
    .eq("monitor", "approved");
  if (error) throw error;
  const rows = (data as { agent_id: string; pipeline: Pipeline }[]) ?? [];

  // "qualified" = past the top of the funnel (anything the agent is actively
  // working), excluding no_reply and waste dead-ends.
  const qualifiedStages = new Set<Pipeline>([
    "qualifies",
    "details_sent",
    "meeting_done",
    "eoi",
    "deal_closed",
  ]);
  const byAgent = new Map<string, AgentSummary>();
  for (const r of rows) {
    let s = byAgent.get(r.agent_id);
    if (!s) {
      s = { agent_id: r.agent_id, total: 0, qualified: 0, no_reply: 0 };
      byAgent.set(r.agent_id, s);
    }
    s.total++;
    if (qualifiedStages.has(r.pipeline)) s.qualified++;
    if (r.pipeline === "no_reply") s.no_reply++;
  }
  return [...byAgent.values()];
}

export interface BoardLead extends Lead {
  responsiveness: Responsiveness; // live active/awaiting/no_reply badge (not the grouping)
}

/** Approved leads for an agent, each tagged with its live responsiveness so the
 *  card can show an active/awaiting dot. Board GROUPING is by the stored
 *  `pipeline` column (done on the client); this only adds the live badge. */
export async function leadsForBoard(agentId: string): Promise<BoardLead[]> {
  const leads = await listLeads(agentId);
  const out: BoardLead[] = [];
  for (const lead of leads) {
    const r = await responsiveness(agentId, lead.id);
    out.push({ ...lead, responsiveness: r.state });
  }
  return out;
}

export async function getLead(agentId: string, id: number): Promise<Lead | undefined> {
  const { data } = await db
    .from("leads")
    .select("*")
    .eq("agent_id", agentId)
    .eq("id", id)
    .maybeSingle();
  return (data as Lead) ?? undefined;
}

/**
 * Update extracted qualification fields + cached reply options on a lead.
 * Fields are sticky: a null extraction (the model didn't surface it this pass)
 * keeps the prior value — so a known budget/area/requirement never silently
 * reverts. We get the old COALESCE semantics by omitting null keys from the
 * update object, so Postgres leaves those columns untouched. A real correction
 * still lands — it arrives non-null.
 */
export async function updateLeadQualification(
  agentId: string,
  id: number,
  fields: {
    budget: string | null;
    area: string | null;
    requirement: string | null;
    deal_type: string | null;
    unit_type: string | null;
    beds: string | null;
    timeline: string | null;
    stage: Stage;
    next_question: string | null;
    replies: string[];
  },
): Promise<void> {
  const update: Record<string, unknown> = {
    stage: fields.stage,
    next_question: fields.next_question,
    replies_json: JSON.stringify(fields.replies),
    updated_at: new Date().toISOString(),
  };
  // Only non-null sticky fields go in — a null one is left alone (COALESCE).
  if (fields.budget !== null) update.budget = fields.budget;
  if (fields.area !== null) update.area = fields.area;
  if (fields.requirement !== null) update.requirement = fields.requirement;
  if (fields.deal_type !== null) update.deal_type = fields.deal_type;
  if (fields.unit_type !== null) update.unit_type = fields.unit_type;
  if (fields.beds !== null) update.beds = fields.beds;
  if (fields.timeline !== null) update.timeline = fields.timeline;

  const { error } = await db.from("leads").update(update).eq("agent_id", agentId).eq("id", id);
  if (error) throw error;
}

/** Insert a message. Returns false if this waId was already stored (provider re-delivery). */
export async function saveMessage(
  agentId: string,
  leadId: number,
  direction: "in" | "out",
  body: string,
  waId?: string,
): Promise<boolean> {
  const row = { agent_id: agentId, lead_id: leadId, direction, body, wa_id: waId ?? null };
  // Plain insert + catch the unique violation. The dedup index is PARTIAL
  // (wa_id is not null), which ON CONFLICT can't target by column list — so we
  // let a duplicate non-null wa_id raise 23505 and report it as "already stored".
  // Null wa_id never trips the partial index, so outbound/simulated rows always land.
  const { error } = await db.from("messages").insert(row);
  if (error) {
    if (error.code === "23505") return false; // duplicate wa_id (provider re-delivery)
    throw error;
  }
  return true;
}

/**
 * Layer-3 voice samples: the agent's own recent outbound texts, across all their
 * leads, for few-shot conditioning of the reply model. Filters out messages the
 * agent likely just copied from one of OUR suggestions (exact match against that
 * lead's stored replies_json) — else the system learns to imitate its own AI voice.
 * ponytail: replies_json holds only the LATEST 4 per lead, so this catches the
 * common "copied the last suggestion" case, not every historical copy. Full
 * suggestion-history filtering waits for Workstream B (response-rate labeling).
 */

/** Normalize a message for copy-detection: lowercase, collapse internal
 *  whitespace, strip leading/trailing punctuation. Agents copy a suggestion with
 *  tiny edits (a trailing period, an extra space, a linebreak) — exact matching
 *  misses those and the card learns the AI's own voice back. Exported for the
 *  self-check. ponytail: normalization only; add fuzzy similarity if drift shows. */
export function normalizeForCopyCheck(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "")
    .trim();
}

/** Pure core of recentAgentSamples: keep the first `limit` outbound bodies that
 *  aren't copies of a suggestion. `suggested` must already be normalized (via
 *  normalizeForCopyCheck). Exported for the self-check. */
export function filterVoiceSamples(
  bodies: string[],
  suggested: Set<string>,
  limit: number,
): string[] {
  const out: string[] = [];
  for (const b of bodies) {
    const body = b.trim();
    if (body && !suggested.has(normalizeForCopyCheck(b))) out.push(body);
    if (out.length >= limit) break;
  }
  return out;
}

/** Normalized set of every suggestion we ever stored for these leads (from their
 *  replies_json). Used to drop outbound messages the agent just copied from us.
 *  ponytail: replies_json holds only the LATEST 4 per lead — catches the common
 *  "copied the last suggestion" case, not every historical copy (Workstream B). */
async function suggestedRepliesFor(agentId: string, leadIds: number[]): Promise<Set<string>> {
  const suggested = new Set<string>();
  if (!leadIds.length) return suggested;
  const { data: leadRows } = await db
    .from("leads")
    .select("id, replies_json")
    .eq("agent_id", agentId)
    .in("id", leadIds);
  for (const l of (leadRows as { id: number; replies_json: string | null }[]) ?? []) {
    if (!l.replies_json) continue;
    try {
      for (const r of JSON.parse(l.replies_json) as string[]) {
        const t = normalizeForCopyCheck(r);
        if (t) suggested.add(t);
      }
    } catch {
      /* malformed json — skip this lead's filter */
    }
  }
  return suggested;
}

export async function recentAgentSamples(agentId: string, limit = 15): Promise<string[]> {
  // Pull a bit extra so filtering copies still leaves ~limit real ones.
  const { data, error } = await db
    .from("messages")
    .select("body, lead_id")
    .eq("agent_id", agentId)
    .eq("direction", "out")
    .order("id", { ascending: false })
    .limit(limit * 3);
  if (error) throw error;
  const rows = (data as { body: string; lead_id: number }[]) ?? [];
  if (!rows.length) return [];

  const leadIds = [...new Set(rows.map((r) => r.lead_id))];
  const suggested = await suggestedRepliesFor(agentId, leadIds);
  return filterVoiceSamples(rows.map((r) => r.body), suggested, limit);
}

// The distill job folds at most this many real messages per run. "All unseen
// since card_upto" is unbounded — if the job breaks for a week or card_upto is
// 0, one prompt could balloon. Cap it; surplus folds on the next outbound trigger.
export const DISTILL_BATCH_MAX = 60;

/** Outbound messages the agent hand-sent since `sinceId`, oldest→newest, with
 *  their ids (to advance card_upto), minus verbatim/near-verbatim copies of our
 *  own suggestions. Capped at DISTILL_BATCH_MAX. The `capped` flag is true when
 *  more rows remained past the cap (for observability). Returns [] when nothing new. */
export async function unfoldedAgentSamples(
  agentId: string,
  sinceId: number,
): Promise<{ samples: { id: number; body: string }[]; capped: boolean }> {
  // Pull one extra past the cap so we can tell "exactly full" from "more remain".
  // Note: filtered copies below can shrink this under the cap even when capped is
  // true — acceptable, the surplus folds next trigger regardless.
  const { data, error } = await db
    .from("messages")
    .select("id, body, lead_id")
    .eq("agent_id", agentId)
    .eq("direction", "out")
    .gt("id", sinceId)
    .order("id", { ascending: true })
    .limit(DISTILL_BATCH_MAX + 1);
  if (error) throw error;
  const rows = (data as { id: number; body: string; lead_id: number }[]) ?? [];
  if (!rows.length) return { samples: [], capped: false };

  const capped = rows.length > DISTILL_BATCH_MAX;
  const batch = rows.slice(0, DISTILL_BATCH_MAX);
  const leadIds = [...new Set(batch.map((r) => r.lead_id))];
  const suggested = await suggestedRepliesFor(agentId, leadIds);
  const samples = batch.filter((r) => {
    const body = r.body.trim();
    return body && !suggested.has(normalizeForCopyCheck(r.body));
  });
  return { samples: samples.map((r) => ({ id: r.id, body: r.body })), capped };
}

// Layer 2C: in-flight state of an agent's WhatsApp voice interview. null = none.
export type InterviewState = {
  phase: "awaiting_consent" | "interviewing";
  step: number; // 0-based scenario index
  replies: string[]; // captured verbatim, extracted into the card at wrap
};

/** Read the agent's interview state (null if no interview in progress). The row
 *  may not exist yet (agent never onboarded) — treated as null. */
export async function getInterviewState(agentId: string): Promise<InterviewState | null> {
  const { data } = await db
    .from("agent_persona")
    .select("interview_state")
    .eq("agent_id", agentId)
    .maybeSingle();
  return (data?.interview_state as InterviewState | null) ?? null;
}

/** Write the agent's interview state (null clears it). Upserts so an agent with no
 *  persona row yet can still start an interview — the card stays null until wrap. */
export async function setInterviewState(
  agentId: string,
  state: InterviewState | null,
): Promise<void> {
  const { error } = await db
    .from("agent_persona")
    .upsert(
      { agent_id: agentId, interview_state: state, updated_at: new Date().toISOString() },
      { onConflict: "agent_id" },
    );
  if (error) throw error;
}

// Layer 2: the agent's persisted voice card (markdown blob) seeded by the
// role-play onboarding skill. Empty string = no card yet → generic fallback.
export async function getVoiceCard(agentId: string): Promise<string> {
  const { data } = await db
    .from("agent_persona")
    .select("voice_card")
    .eq("agent_id", agentId)
    .maybeSingle();
  return (data?.voice_card as string | null) ?? "";
}

/** Card + watermark for the distill job. Missing row → { card: "", upto: 0 }
 *  (cold start). getVoiceCard stays lean for the hot reply path. */
export async function getVoiceCardState(
  agentId: string,
): Promise<{ card: string; upto: number }> {
  const { data } = await db
    .from("agent_persona")
    .select("voice_card, card_upto")
    .eq("agent_id", agentId)
    .maybeSingle();
  const row = data as { voice_card: string | null; card_upto: number } | null;
  return { card: row?.voice_card ?? "", upto: row?.card_upto ?? 0 };
}

/** Highest outbound message id for an agent, across all leads (0 if none). Used
 *  to set card_upto = current baseline when the seed card is saved, so the first
 *  distill folds only FUTURE messages, not the whole back-catalogue. */
export async function maxOutboundId(agentId: string): Promise<number> {
  const { data } = await db
    .from("messages")
    .select("id")
    .eq("agent_id", agentId)
    .eq("direction", "out")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.id as number | null) ?? 0;
}

/** Overwrite the agent's voice card and advance the watermark, and log the change
 *  to agent_persona_versions (rollback + drift audit). Upsert so it also seeds a
 *  fresh row. The version row is written first: if the log insert fails we abort
 *  before mutating the live card, so we never have an untracked overwrite. */
export async function saveVoiceCard(
  agentId: string,
  card: string,
  upto: number,
  meta: { fromUpto: number; sampleCount: number },
): Promise<void> {
  const prior = await getVoiceCardState(agentId);
  const { error: logErr } = await db.from("agent_persona_versions").insert({
    agent_id: agentId,
    prior_card: prior.card || null,
    new_card: card,
    from_upto: meta.fromUpto,
    to_upto: upto,
    sample_count: meta.sampleCount,
  });
  if (logErr) throw logErr;

  const { error } = await db.from("agent_persona").upsert(
    { agent_id: agentId, voice_card: card, card_upto: upto, updated_at: new Date().toISOString() },
    { onConflict: "agent_id" },
  );
  if (error) throw error;
}

export async function getMessages(agentId: string, leadId: number): Promise<Message[]> {
  const { data, error } = await db
    .from("messages")
    .select("*")
    .eq("agent_id", agentId)
    .eq("lead_id", leadId)
    .order("id", { ascending: true });
  if (error) throw error;
  return (data as Message[]) ?? [];
}

/** Save the rolling summary + replace the fact list for a lead (single memory write).
 *  upto = id of the newest message folded into this summary (the watermark). */
export async function saveMemory(
  agentId: string,
  leadId: number,
  summary: string,
  facts: string[],
  upto: number,
): Promise<void> {
  const { error: upErr } = await db
    .from("leads")
    .update({ summary, summary_upto: upto, updated_at: new Date().toISOString() })
    .eq("agent_id", agentId)
    .eq("id", leadId);
  if (upErr) throw upErr;

  await db.from("memory").delete().eq("agent_id", agentId).eq("lead_id", leadId);

  // Strip any leading bullet the model echoed back (the fold-in prompt shows
  // prior facts as "- fact", and the model sometimes copies the dash in), dedup.
  const seen = new Set<string>();
  const rows: { agent_id: string; lead_id: number; fact: string }[] = [];
  for (const f of facts) {
    const clean = f.replace(/^[-*•\s]+/, "").trim();
    const dedupKey = clean.toLowerCase();
    if (clean && !seen.has(dedupKey)) {
      seen.add(dedupKey);
      rows.push({ agent_id: agentId, lead_id: leadId, fact: clean });
    }
  }
  if (rows.length) {
    const { error } = await db.from("memory").insert(rows);
    if (error) throw error;
  }
}

export async function getFacts(agentId: string, leadId: number): Promise<string[]> {
  const { data, error } = await db
    .from("memory")
    .select("fact")
    .eq("agent_id", agentId)
    .eq("lead_id", leadId)
    .order("id", { ascending: true });
  if (error) throw error;
  return ((data as { fact: string }[]) ?? []).map((r) => r.fact);
}

/** Approved leads only — pending/rejected numbers (the approval gate) are not
 *  leads the agent is working, so they never show up in counts or reminders. */
export async function listLeads(agentId: string): Promise<Lead[]> {
  const { data, error } = await db
    .from("leads")
    .select("*")
    .eq("agent_id", agentId)
    .eq("monitor", "approved")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data as Lead[]) ?? [];
}

// A lead is "no reply" once the agent's last message has gone unanswered past this.
// Also the WhatsApp free-text window, so past it you'd need a template anyway.
const QUIET_MS = 24 * 60 * 60 * 1000;

export type Responsiveness = "active" | "awaiting_reply" | "no_reply";

/**
 * Derived live from the messages — no stored column. An inbound message is the
 * only thing that resets it: last message inbound => "active" (ball's in the
 * agent's court). Last message outbound => "awaiting_reply", hardening into
 * "no_reply" after QUIET_MS. Returns null age when there are no messages yet.
 */
export async function responsiveness(
  agentId: string,
  leadId: number,
): Promise<{ state: Responsiveness; last_direction: "in" | "out" | null; silent_ms: number | null }> {
  const { data } = await db
    .from("messages")
    .select("direction, ts")
    .eq("agent_id", agentId)
    .eq("lead_id", leadId)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  const last = data as { direction: "in" | "out"; ts: string } | null;

  if (!last) return { state: "active", last_direction: null, silent_ms: null };
  if (last.direction === "in") {
    return { state: "active", last_direction: "in", silent_ms: null };
  }
  // Outbound last: measure how long the lead has been silent. Postgres returns
  // ts as an ISO-8601 timestamptz, so Date.parse handles the zone directly.
  const silent = Date.now() - Date.parse(last.ts);
  return {
    state: silent >= QUIET_MS ? "no_reply" : "awaiting_reply",
    last_direction: "out",
    silent_ms: silent,
  };
}
