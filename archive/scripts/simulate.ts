import "dotenv/config";
import assert from "node:assert";
import { handleInbound } from "../src/webhook.js";
import { getLead } from "../src/store.js";

const AGENT_ID = process.env.AGENT_ID ?? "agent_demo";

/**
 * Inject a fake inbound message straight through the Stage-1 loop (no HTTP,
 * no phone number needed). Runs with BSP=mock + a real ANTHROPIC_API_KEY.
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

  console.log(`Injecting inbound from ${phone}: "${text}"`);
  const leadId = await handleInbound(phone, text, "Demo Lead");
  const lead = getLead(AGENT_ID, leadId);
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
