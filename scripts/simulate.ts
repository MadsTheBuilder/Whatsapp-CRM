import "dotenv/config";
import assert from "node:assert";
import { handleAgentMessage } from "../src/brain.js";
import { getLead, createPendingLead, setMonitor } from "../src/store.js";

const AGENT_ID = process.env.AGENT_ID ?? "agent_demo";

/**
 * Inject a fake inbound lead message straight through the Stage-1 brain (no HTTP,
 * no Baileys) as one normalized AgentMessageEvent. Needs a live Supabase store +
 * a model key (the brain qualifies and writes replies for real).
 *
 *   npm run simulate -- "Looking for a 2BR in JVC, budget around 1.4M"
 *   npm run check      # self-check: asserts lead + fields + 4 replies
 */
async function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const text =
    args.filter((a) => a !== "--check").join(" ").trim() ||
    "Looking for a 2BR in JVC, budget around 1.4M, want to buy off-plan";
  const phone = "971500000001";

  // Pre-approve the sender: the brain now gates unknown numbers (approval flow),
  // so a raw first message would just land 'pending' and be dropped. This check
  // exercises the qualify→reply path of an already-approved lead.
  await createPendingLead(AGENT_ID, phone, "Demo Lead");
  await setMonitor(AGENT_ID, phone, "approved");

  console.log(`Injecting inbound from ${phone}: "${text}"`);
  const leadId = await handleAgentMessage({
    agentId: AGENT_ID,
    leadNumber: phone,
    direction: "in",
    text,
    timestamp: Date.now(),
    leadName: "Demo Lead",
  });
  const lead = await getLead(AGENT_ID, leadId);
  assert(lead, "lead should exist after inbound");

  const replies: string[] = lead.replies_json ? JSON.parse(lead.replies_json) : [];
  console.log("\nExtracted:");
  console.log("  budget      :", lead.budget);
  console.log("  area        :", lead.area);
  console.log("  requirement :", lead.requirement);
  console.log("  next question:", lead.next_question);
  console.log("\n4 suggested replies:");
  replies.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));

  if (isCheck) {
    // (a) a leads row exists for the sender, carrying agent_id
    assert.equal(lead.agent_id, AGENT_ID, "lead carries agent_id");
    assert.equal(lead.phone, phone, "lead matches sender phone");
    // (b) at least one extracted field is populated (this input states all three)
    assert(
      lead.budget || lead.area || lead.requirement,
      "at least one qualification field populated",
    );
    // (c) exactly 4 reply options were generated
    assert.equal(replies.length, 4, "exactly 4 reply options generated");
    console.log("\n✓ check passed: lead+agent_id, extracted fields, 4 replies");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
