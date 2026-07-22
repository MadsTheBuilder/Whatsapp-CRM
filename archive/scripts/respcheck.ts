import "dotenv/config";
import assert from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { responsiveness } from "../src/store.js";

/**
 * Self-check for the derived non-responsive detection. Inserts messages with
 * controlled UTC timestamps for a throwaway lead and asserts each of the three
 * states plus the 24h boundary. Cleans up after itself.
 *
 *   npm run respcheck
 */
const AGENT = "respcheck_agent";
const db = new DatabaseSync("fourthspace.db");

function reset(leadId: number) {
  db.prepare("DELETE FROM messages WHERE agent_id = ? AND lead_id = ?").run(AGENT, leadId);
}
function add(leadId: number, dir: "in" | "out", agoHours: number) {
  const ts = new Date(Date.now() - agoHours * 3_600_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19); // "YYYY-MM-DD HH:MM:SS" UTC, matching SQLite's datetime('now')
  db.prepare(
    "INSERT INTO messages (agent_id, lead_id, direction, body, ts) VALUES (?, ?, ?, 'x', ?)",
  ).run(AGENT, leadId, dir, ts);
}

// Throwaway lead so the messages FK is satisfied; removed at the end.
const LEAD = Number(
  db
    .prepare("INSERT INTO leads (agent_id, phone, stage, status) VALUES (?, 'respcheck', 'first_contact', 'open')")
    .run(AGENT).lastInsertRowid,
);

// 1. No messages at all -> active (nothing owed yet).
reset(LEAD);
assert.equal(responsiveness(AGENT, LEAD).state, "active", "no messages => active");

// 2. Lead spoke last -> active (ball's in agent's court).
reset(LEAD);
add(LEAD, "out", 50);
add(LEAD, "in", 1);
assert.equal(responsiveness(AGENT, LEAD).state, "active", "inbound last => active");

// 3. Agent spoke last, 2h ago -> awaiting_reply.
reset(LEAD);
add(LEAD, "in", 5);
add(LEAD, "out", 2);
assert.equal(responsiveness(AGENT, LEAD).state, "awaiting_reply", "out 2h => awaiting");

// 4. Agent spoke last, 30h ago -> no_reply.
reset(LEAD);
add(LEAD, "out", 30);
assert.equal(responsiveness(AGENT, LEAD).state, "no_reply", "out 30h => no_reply");

// 5. Boundary: 25h -> no_reply, 23h -> awaiting.
reset(LEAD);
add(LEAD, "out", 25);
assert.equal(responsiveness(AGENT, LEAD).state, "no_reply", "out 25h => no_reply");
reset(LEAD);
add(LEAD, "out", 23);
assert.equal(responsiveness(AGENT, LEAD).state, "awaiting_reply", "out 23h => awaiting");

reset(LEAD);
db.prepare("DELETE FROM leads WHERE agent_id = ? AND id = ?").run(AGENT, LEAD);
console.log("✓ respcheck passed: active / awaiting_reply / no_reply + 24h boundary");
