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

// Approval gate: a number the read-pipe sees is only processed once the agent
// opts it in. New numbers land 'pending'; the agent taps Yes/No to approve/reject.
export type Monitor = "pending" | "approved" | "rejected";

export interface Lead {
  id: number;
  agent_id: string;
  phone: string;
  name: string | null;
  stage: Stage;
  monitor: Monitor;
  budget: string | null;
  area: string | null;
  requirement: string | null;
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
