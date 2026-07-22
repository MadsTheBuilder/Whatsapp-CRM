import "dotenv/config";
import assert from "node:assert";
import { handleInbound } from "../src/webhook.js";
import { getLead, getFacts } from "../src/store.js";

const AGENT_ID = process.env.AGENT_ID ?? "agent_demo";

/**
 * Drive a multi-turn conversation past SUMMARIZE_AFTER (6 messages) and assert
 * the lead gains a rolling summary + at least one durable fact. Uses a fresh
 * phone each run (timestamp-free: derived from message count) so it never
 * collides with an existing lead's history.
 *
 *   npm run memcheck
 */
async function main() {
  const phone = "971500000777";
  // 7 inbound turns > SUMMARIZE_AFTER (6), so the summary fires on the last one.
  const turns = [
    "Hi, saw your listing in JVC",
    "Looking to buy, not rent",
    "Budget around 1.4M AED, bit flexible with a payment plan",
    "Prefer a high floor",
    "I've got a young kid so near a school matters",
    "Off-plan 1BR ideally",
    "Can you send me the floor plan you mentioned?",
  ];

  let leadId = 0;
  for (const t of turns) {
    console.log(`Lead: ${t}`);
    leadId = await handleInbound(phone, t, "Memory Demo");
  }

  const lead = getLead(AGENT_ID, leadId);
  assert(lead, "lead should exist");
  const facts = getFacts(AGENT_ID, leadId);

  console.log("\nSummary:\n ", lead.summary);
  console.log("\nFacts:");
  facts.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));

  assert(lead.summary && lead.summary.trim().length > 0, "summary was generated and stored");
  assert(facts.length > 0, "at least one durable fact was stored");
  console.log("\n✓ memcheck passed: summary + facts persisted after threshold");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
