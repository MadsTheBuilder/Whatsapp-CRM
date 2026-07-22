import "dotenv/config";
import assert from "node:assert";
import { handleAgentMessage } from "../src/brain.js";
import { getLead, getFacts, createPendingLead, setMonitor } from "../src/store.js";

const AGENT_ID = process.env.AGENT_ID ?? "agent_demo";

/**
 * Drive a multi-turn conversation past SUMMARIZE_AFTER (6 messages) and assert the
 * lead gains a rolling summary + at least one durable fact. Needs a live Supabase
 * store + a model key. Uses a fixed throwaway phone; re-running just re-summarizes
 * the same lead's (now longer) history, which is fine.
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

  // Pre-approve: the brain gates unknown numbers now, so drive an approved lead.
  await createPendingLead(AGENT_ID, phone, "Memory Demo");
  await setMonitor(AGENT_ID, phone, "approved");

  let leadId = 0;
  for (const t of turns) {
    console.log(`Lead: ${t}`);
    leadId = await handleAgentMessage({
      agentId: AGENT_ID,
      leadNumber: phone,
      direction: "in",
      text: t,
      timestamp: Date.now(),
      leadName: "Memory Demo",
    });
  }

  const lead = await getLead(AGENT_ID, leadId);
  assert(lead, "lead should exist");
  const facts = await getFacts(AGENT_ID, leadId);

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
