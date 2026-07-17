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
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(agent_id, phone)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id   TEXT NOT NULL,
    lead_id    INTEGER NOT NULL,
    direction  TEXT NOT NULL,            -- 'in' | 'out'
    body       TEXT NOT NULL,
    ts         TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id)
  );
`);

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

/** Update extracted qualification fields + cached reply options on a lead. */
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
       SET budget = ?, area = ?, requirement = ?, stage = ?,
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

export function saveMessage(
  agentId: string,
  leadId: number,
  direction: "in" | "out",
  body: string,
): void {
  db.prepare(
    "INSERT INTO messages (agent_id, lead_id, direction, body) VALUES (?, ?, ?, ?)",
  ).run(agentId, leadId, direction, body);
}

export function getMessages(agentId: string, leadId: number): Message[] {
  return db
    .prepare(
      "SELECT * FROM messages WHERE agent_id = ? AND lead_id = ? ORDER BY id ASC",
    )
    .all(agentId, leadId) as unknown as Message[];
}

export function listLeads(agentId: string): Lead[] {
  return db
    .prepare("SELECT * FROM leads WHERE agent_id = ? ORDER BY updated_at DESC")
    .all(agentId) as unknown as Lead[];
}
