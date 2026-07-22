import { DatabaseSync } from "node:sqlite";

// Single-file SQLite via Node's built-in module (no native build). agent_id
// lives on every row from the first insert so the multi-tenant shape is real
// even while the demo runs one agent.
// ponytail: single DB file, no migrations tool — add one when the schema churns.
const db = new DatabaseSync("fourthspace.db");
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id     TEXT NOT NULL,
    phone        TEXT NOT NULL,
    name         TEXT,
    stage        TEXT NOT NULL DEFAULT 'first_contact',
    budget       TEXT,
    area         TEXT,
    requirement  TEXT,
    status       TEXT NOT NULL DEFAULT 'open',
    next_question TEXT,
    replies_json TEXT,
    summary      TEXT,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(agent_id, phone)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id   TEXT NOT NULL,
    lead_id    INTEGER NOT NULL,
    direction  TEXT NOT NULL,            -- 'in' | 'out'
    body       TEXT NOT NULL,
    wa_id      TEXT,                      -- Meta's message id (wamid...) for dedup; null for outbound/simulated
    ts         TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id)
  );

  -- Durable per-lead facts (preferences, objections, promises, personal details).
  -- Rewritten wholesale each time memory is regenerated, so it stays deduped.
  CREATE TABLE IF NOT EXISTS memory (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    lead_id  INTEGER NOT NULL,
    fact     TEXT NOT NULL,
    FOREIGN KEY (lead_id) REFERENCES leads(id)
  );
`);

// Add summary to pre-existing DBs that were created before this column existed.
// ponytail: hand-rolled add-column-if-missing; a migrations tool when the schema churns.
{
  const cols = db.prepare("PRAGMA table_info(leads)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "summary")) {
    db.exec("ALTER TABLE leads ADD COLUMN summary TEXT");
  }
  // Watermark: id of the last message already folded into the summary. Lets us
  // summarize incrementally (prev summary + only newer messages) instead of
  // re-reading the whole transcript every turn.
  if (!cols.some((c) => c.name === "summary_upto")) {
    db.exec("ALTER TABLE leads ADD COLUMN summary_upto INTEGER NOT NULL DEFAULT 0");
  }
}

// Add wa_id + its unique index to pre-existing DBs. Deduplicates Meta webhook
// re-deliveries (the same wamid arrives more than once when we ack slowly).
{
  const cols = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "wa_id")) {
    db.exec("ALTER TABLE messages ADD COLUMN wa_id TEXT");
  }
  // Partial unique index: only non-null wa_ids collide, so outbound/simulated rows
  // (wa_id null) are unaffected.
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_wa_id ON messages(agent_id, wa_id) WHERE wa_id IS NOT NULL",
  );
}

export type Stage = "first_contact" | "following_up" | "deep";

export interface Lead {
  id: number;
  agent_id: string;
  phone: string;
  name: string | null;
  stage: Stage;
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

/** Find an existing lead by phone or create one. agent_id scopes every lookup. */
export function upsertLead(agentId: string, phone: string, name?: string): Lead {
  const existing = db
    .prepare("SELECT * FROM leads WHERE agent_id = ? AND phone = ?")
    .get(agentId, phone) as unknown as Lead | undefined;
  if (existing) {
    if (name && !existing.name) {
      db.prepare("UPDATE leads SET name = ? WHERE id = ?").run(name, existing.id);
      existing.name = name;
    }
    return existing;
  }
  const info = db
    .prepare("INSERT INTO leads (agent_id, phone, name) VALUES (?, ?, ?)")
    .run(agentId, phone, name ?? null);
  return getLead(agentId, Number(info.lastInsertRowid))!;
}

export function getLead(agentId: string, id: number): Lead | undefined {
  return db
    .prepare("SELECT * FROM leads WHERE agent_id = ? AND id = ?")
    .get(agentId, id) as unknown as Lead | undefined;
}

/**
 * Update extracted qualification fields + cached reply options on a lead.
 * Fields are sticky: a null extraction (the model didn't surface it this pass)
 * keeps the prior value via COALESCE, so a known budget/area/requirement never
 * silently reverts. A real correction still lands — it arrives non-null.
 */
export function updateLeadQualification(
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
): void {
  db.prepare(
    `UPDATE leads
       SET budget      = COALESCE(?, budget),
           area        = COALESCE(?, area),
           requirement = COALESCE(?, requirement),
           stage       = ?,
           next_question = ?, replies_json = ?, updated_at = datetime('now')
     WHERE agent_id = ? AND id = ?`,
  ).run(
    fields.budget,
    fields.area,
    fields.requirement,
    fields.stage,
    fields.next_question,
    JSON.stringify(fields.replies),
    agentId,
    id,
  );
}

/** Insert a message. Returns false if this waId was already stored (Meta re-delivery). */
export function saveMessage(
  agentId: string,
  leadId: number,
  direction: "in" | "out",
  body: string,
  waId?: string,
): boolean {
  const info = db
    .prepare(
      "INSERT OR IGNORE INTO messages (agent_id, lead_id, direction, body, wa_id) VALUES (?, ?, ?, ?, ?)",
    )
    .run(agentId, leadId, direction, body, waId ?? null);
  return info.changes > 0;
}

export function getMessages(agentId: string, leadId: number): Message[] {
  return db
    .prepare(
      "SELECT * FROM messages WHERE agent_id = ? AND lead_id = ? ORDER BY id ASC",
    )
    .all(agentId, leadId) as unknown as Message[];
}

/** Save the rolling summary + replace the fact list for a lead (single memory write).
 *  upto = id of the newest message folded into this summary (the watermark). */
export function saveMemory(
  agentId: string,
  leadId: number,
  summary: string,
  facts: string[],
  upto: number,
): void {
  db.prepare(
    "UPDATE leads SET summary = ?, summary_upto = ?, updated_at = datetime('now') WHERE agent_id = ? AND id = ?",
  ).run(summary, upto, agentId, leadId);
  db.prepare("DELETE FROM memory WHERE agent_id = ? AND lead_id = ?").run(agentId, leadId);
  const ins = db.prepare(
    "INSERT INTO memory (agent_id, lead_id, fact) VALUES (?, ?, ?)",
  );
  // Strip any leading bullet the model echoed back (the fold-in prompt shows
  // prior facts as "- fact", and the model sometimes copies the dash in).
  const seen = new Set<string>();
  for (const f of facts) {
    const clean = f.replace(/^[-*•\s]+/, "").trim();
    const key = clean.toLowerCase();
    if (clean && !seen.has(key)) {
      seen.add(key);
      ins.run(agentId, leadId, clean);
    }
  }
}

export function getFacts(agentId: string, leadId: number): string[] {
  return (
    db
      .prepare("SELECT fact FROM memory WHERE agent_id = ? AND lead_id = ? ORDER BY id ASC")
      .all(agentId, leadId) as { fact: string }[]
  ).map((r) => r.fact);
}

export function listLeads(agentId: string): Lead[] {
  return db
    .prepare("SELECT * FROM leads WHERE agent_id = ? ORDER BY updated_at DESC")
    .all(agentId) as unknown as Lead[];
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
export function responsiveness(
  agentId: string,
  leadId: number,
): { state: Responsiveness; last_direction: "in" | "out" | null; silent_ms: number | null } {
  const last = db
    .prepare(
      "SELECT direction, ts FROM messages WHERE agent_id = ? AND lead_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(agentId, leadId) as { direction: "in" | "out"; ts: string } | undefined;

  if (!last) return { state: "active", last_direction: null, silent_ms: null };
  if (last.direction === "in") {
    return { state: "active", last_direction: "in", silent_ms: null };
  }
  // Outbound last: measure how long the lead has been silent. SQLite stores ts as
  // UTC "YYYY-MM-DD HH:MM:SS"; append Z so Date parses it as UTC, not local.
  const sentAt = Date.parse(last.ts.replace(" ", "T") + "Z");
  const silent = Date.now() - sentAt;
  return {
    state: silent >= QUIET_MS ? "no_reply" : "awaiting_reply",
    last_direction: "out",
    silent_ms: silent,
  };
}
