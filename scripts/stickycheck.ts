import "dotenv/config";
import assert from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { updateLeadQualification, getLead } from "../src/store.js";

/**
 * Sticky-field self-check: a null extraction must NOT wipe a known field, but a
 * non-null value (a real correction) must overwrite. Needs a live Supabase store.
 * Throwaway lead, cleaned up.
 *
 *   npm run stickycheck
 */
const AGENT = "stickycheck_agent";
const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const db = createClient(url, key, { auth: { persistSession: false } });

const { data: leadRow, error: leadErr } = await db
  .from("leads")
  .insert({ agent_id: AGENT, phone: "sticky", stage: "first_contact", status: "open" })
  .select("id")
  .single();
if (leadErr) throw leadErr;
const id = (leadRow as { id: number }).id;

// 1. First pass extracts area=JVC, budget=1.4M.
await updateLeadQualification(AGENT, id, {
  budget: "1.4M", area: "JVC", requirement: null,
  stage: "following_up", next_question: null, replies: [],
});
let lead = (await getLead(AGENT, id))!;
assert.equal(lead.area, "JVC", "area set on first pass");
assert.equal(lead.budget, "1.4M", "budget set on first pass");

// 2. Model thrashes: this pass returns area=null. Known value must survive.
await updateLeadQualification(AGENT, id, {
  budget: null, area: null, requirement: "off-plan 2BR",
  stage: "deep", next_question: null, replies: [],
});
lead = (await getLead(AGENT, id))!;
assert.equal(lead.area, "JVC", "null extraction did NOT wipe area");
assert.equal(lead.budget, "1.4M", "null extraction did NOT wipe budget");
assert.equal(lead.requirement, "off-plan 2BR", "new non-null requirement landed");

// 3. Real correction: lead changes area to Marina (non-null) — must overwrite.
await updateLeadQualification(AGENT, id, {
  budget: null, area: "Dubai Marina", requirement: null,
  stage: "deep", next_question: null, replies: [],
});
lead = (await getLead(AGENT, id))!;
assert.equal(lead.area, "Dubai Marina", "non-null correction overwrote area");

await db.from("leads").delete().eq("agent_id", AGENT).eq("id", id);
console.log("✓ stickycheck passed: null keeps prior value, non-null overwrites");
