import "dotenv/config";
import {
  createPendingLead,
  setLeadLid,
  findLeadByLid,
  findLeadByPhone,
} from "../src/store.js";

// THROWAWAY live round-trip of the lid↔phone link (store.ts). Needs live
// SUPABASE_* and migration 007 applied. Proves: setLeadLid persists, findLeadByLid
// resolves back to the same lead, and the null-guard doesn't thrash a stored lid.
//   npx tsx scripts/lidlink.test.ts
import assert from "node:assert";

const AGENT_ID = process.env.AGENT_ID ?? "agent_demo";
const PHONE = "000lidtest"; // fake, obviously-test phone
const LID = "999lidtest";

async function main() {
  const { lead } = await createPendingLead(AGENT_ID, PHONE, "Lid Test");
  console.log(`test lead id=${lead.id} phone=${PHONE}`);

  await setLeadLid(AGENT_ID, lead.id, LID);
  const byLid = await findLeadByLid(AGENT_ID, LID);
  assert.strictEqual(byLid?.id, lead.id, "findLeadByLid resolves to the same lead");
  assert.strictEqual(byLid?.lid, LID, "lid persisted on the lead");

  // Null-guard: a second setLeadLid with a different value must NOT overwrite.
  await setLeadLid(AGENT_ID, lead.id, "someothervalue");
  const byPhone = await findLeadByPhone(AGENT_ID, PHONE);
  assert.strictEqual(byPhone?.lid, LID, "stored lid is not thrashed by a later setLeadLid");

  console.log("lid link round-trip passed ✓");
  console.log(`(cleanup: delete from leads where agent_id='${AGENT_ID}' and phone='${PHONE}';)`);
}

main().catch((e) => {
  console.error("lidlink test failed:", e);
  process.exit(1);
});
