import "dotenv/config";
import { handleAgentMessage } from "../src/brain.js";
import { getLead, createPendingLead, setMonitor, getMessages } from "../src/store.js";

// Reproduces the "November, contract ends then" screenshot end-to-end through the
// live brain (real Supabase + model). Plays the qualifying turns, then the timeline
// line, and prints the 4 replies so you can eyeball whether the input-contract fix
// held: no re-asking the stated timeline, no asserting unstated facts.
//   npm run repro
// Needs: 004_add_timeline.sql applied, REPLY_MODEL set, a model reachable.
const AGENT_ID = process.env.AGENT_ID ?? "agent_demo";
const PHONE = "971500000009";

const TURNS = [
  "Hi, looking to rent a 1BR apartment in JVC",
  "Budget around 90k a year",
  "I want to move in November, preferably the 1st, because my current contract ends then",
];

async function main() {
  // Fresh lead each run so the transcript is exactly these turns.
  await createPendingLead(AGENT_ID, PHONE, "Repro Lead");
  await setMonitor(AGENT_ID, PHONE, "approved");

  let leadId = 0;
  for (const text of TURNS) {
    console.log(`\n> Lead: "${text}"`);
    leadId = await handleAgentMessage({
      agentId: AGENT_ID,
      sendNumber: process.env.AGENT_COMPANY_NUMBER ?? "", // sim: where cards would go
      leadNumber: PHONE,
      direction: "in",
      text,
      timestamp: Date.now(),
      leadName: "Repro Lead",
    });
  }

  const lead = (await getLead(AGENT_ID, leadId))!;
  const replies: string[] = lead.replies_json ? JSON.parse(lead.replies_json) : [];

  console.log("\n=== Extracted after all turns ===");
  console.log("  budget   :", lead.budget);
  console.log("  area     :", lead.area);
  console.log("  deal_type:", lead.deal_type);
  console.log("  unit_type:", lead.unit_type);
  console.log("  beds     :", lead.beds);
  console.log("  timeline :", lead.timeline, lead.timeline ? "  ✅ captured" : "  ❌ still null — bug not fixed");

  console.log("\n=== 4 suggested replies (eyeball these) ===");
  replies.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
  console.log(
    "\nPASS if: none re-ask WHEN they're moving / why the timeline, none assert an\n" +
      "area/property/amenity the lead never named. Timeline above should be non-null.",
  );

  console.log(`\n(transcript length: ${(await getMessages(AGENT_ID, leadId)).length} msgs)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
