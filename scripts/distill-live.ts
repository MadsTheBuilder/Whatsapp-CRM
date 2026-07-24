import "dotenv/config";
import {
  createPendingLead,
  setMonitor,
  saveMessage,
  getVoiceCardState,
} from "../src/store.js";
import { maybeDistillVoiceCard, DISTILL_THRESHOLD } from "../src/distill.js";

// THROWAWAY live proof of the voice-card distill loop — no Baileys, no HTTP.
// Seeds an approved test lead, inserts DISTILL_THRESHOLD distinctive outbound
// messages, then runs the real maybeDistillVoiceCard against live Supabase +
// model. Proves: threshold gate → fold → save → watermark advance → version log.
// Needs live SUPABASE_* + a model key. Delete after the test.
//   npx tsx scripts/distill-live.ts
const AGENT_ID = process.env.AGENT_ID ?? "agent_demo";
const TEST_PHONE = "000distilltest"; // fake, obviously-test phone — never a real lead

// Distinctive voice so the fold is visible in the card: terse, no emoji, dry.
const SAMPLES = [
  "yeah that one's still available. want to see it this week?",
  "price is firm. it's already below the last two closes in that building.",
  "no rush. ping me when you've thought it over.",
  "cash or mortgage? changes what i pull for you.",
  "saw your message. give me till evening, chasing the owner now.",
  "honestly that unit's overpriced. i'd skip it.",
];

async function main() {
  const n = DISTILL_THRESHOLD;
  console.log(`AGENT_ID=${AGENT_ID}  DISTILL_THRESHOLD=${n}`);
  if (SAMPLES.length < n) {
    console.error(`Only ${SAMPLES.length} sample msgs but threshold is ${n}. Lower DISTILL_THRESHOLD in .env or add samples.`);
    process.exit(1);
  }

  // Approved test lead (idempotent: reuse the row if it already exists).
  const { lead } = await createPendingLead(AGENT_ID, TEST_PHONE, "Distill Test");
  await setMonitor(AGENT_ID, TEST_PHONE, "approved");
  console.log(`test lead id=${lead.id} (${TEST_PHONE}) approved`);

  const before = await getVoiceCardState(AGENT_ID);
  console.log(`\n--- BEFORE ---\ncard_upto=${before.upto}\ncard:\n${before.card || "(empty)"}\n`);

  // Insert the outbound messages (wa_id null → always land, never dedup-dropped).
  for (const body of SAMPLES.slice(0, n)) {
    await saveMessage(AGENT_ID, lead.id, "out", body);
  }
  console.log(`inserted ${n} outbound messages\n`);

  console.log("running maybeDistillVoiceCard...\n");
  const ran = await maybeDistillVoiceCard(AGENT_ID);
  console.log(`\nmaybeDistillVoiceCard returned: ${ran}`);

  const after = await getVoiceCardState(AGENT_ID);
  console.log(`\n--- AFTER ---\ncard_upto=${after.upto}\ncard:\n${after.card || "(empty)"}\n`);

  console.log("--- CHECKS ---");
  console.log(`distill ran:            ${ran ? "YES ✓" : "NO ✗"}`);
  console.log(`card_upto advanced:     ${after.upto > before.upto ? `YES ✓ (${before.upto}→${after.upto})` : "NO ✗"}`);
  console.log(`card changed:           ${after.card !== before.card ? "YES ✓" : "NO ✗"}`);
  console.log(`\nInspect the version-log row in Supabase:`);
  console.log(`  select from_upto, to_upto, sample_count, prior_card is null as first_seed, left(new_card,200)`);
  console.log(`  from agent_persona_versions where agent_id = '${AGENT_ID}' order by created_at desc limit 1;`);
}

main().catch((e) => {
  console.error("distill-live failed:", e);
  process.exit(1);
});
