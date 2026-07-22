import "dotenv/config";
import assert from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { responsiveness } from "../src/store.js";

/**
 * Live-store self-check for the derived non-responsive detection. Seeds messages
 * with controlled timestamps for a throwaway lead in Supabase and asserts each of
 * the three states plus the 24h boundary. Needs a live Supabase store. Cleans up
 * after itself.
 *
 *   npm run respcheck
 */
const AGENT = "respcheck_agent";
const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const db = createClient(url, key, { auth: { persistSession: false } });

async function reset(leadId: number) {
  await db.from("messages").delete().eq("agent_id", AGENT).eq("lead_id", leadId);
}
async function add(leadId: number, dir: "in" | "out", agoHours: number) {
  const ts = new Date(Date.now() - agoHours * 3_600_000).toISOString();
  const { error } = await db
    .from("messages")
    .insert({ agent_id: AGENT, lead_id: leadId, direction: dir, body: "x", ts });
  if (error) throw error;
}

// Throwaway lead so the messages FK is satisfied; removed at the end.
const { data: leadRow, error: leadErr } = await db
  .from("leads")
  .insert({ agent_id: AGENT, phone: "respcheck", stage: "first_contact", status: "open" })
  .select("id")
  .single();
if (leadErr) throw leadErr;
const LEAD = (leadRow as { id: number }).id;

async function stateOf(): Promise<string> {
  return (await responsiveness(AGENT, LEAD)).state;
}

// 1. No messages at all -> active (nothing owed yet).
await reset(LEAD);
assert.equal(await stateOf(), "active", "no messages => active");

// 2. Lead spoke last -> active (ball's in agent's court).
await reset(LEAD);
await add(LEAD, "out", 50);
await add(LEAD, "in", 1);
assert.equal(await stateOf(), "active", "inbound last => active");

// 3. Agent spoke last, 2h ago -> awaiting_reply.
await reset(LEAD);
await add(LEAD, "in", 5);
await add(LEAD, "out", 2);
assert.equal(await stateOf(), "awaiting_reply", "out 2h => awaiting");

// 4. Agent spoke last, 30h ago -> no_reply.
await reset(LEAD);
await add(LEAD, "out", 30);
assert.equal(await stateOf(), "no_reply", "out 30h => no_reply");

// 5. Boundary: 25h -> no_reply, 23h -> awaiting.
await reset(LEAD);
await add(LEAD, "out", 25);
assert.equal(await stateOf(), "no_reply", "out 25h => no_reply");
await reset(LEAD);
await add(LEAD, "out", 23);
assert.equal(await stateOf(), "awaiting_reply", "out 23h => awaiting");

await reset(LEAD);
await db.from("leads").delete().eq("agent_id", AGENT).eq("id", LEAD);
console.log("✓ respcheck passed: active / awaiting_reply / no_reply + 24h boundary");
