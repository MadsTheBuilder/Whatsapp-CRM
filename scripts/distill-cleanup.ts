import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

// THROWAWAY cleanup of the distill live-test artifacts. Deletes the test lead
// 000distilltest + its messages, removes the test version-log row, and RESTORES
// the original seed card (recovered from the version log's prior_card) with
// card_upto set to the current max real outbound id. Read-back at the end to
// confirm. Run once, then delete this script.  npx tsx scripts/distill-cleanup.ts
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
const AGENT_ID = process.env.AGENT_ID ?? "agent_demo";
const TEST_PHONE = "000distilltest";

async function main() {
  // 1. Recover the original seed card from the FIRST version-log row (prior_card).
  const { data: firstVer } = await db
    .from("agent_persona_versions")
    .select("prior_card")
    .eq("agent_id", AGENT_ID)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const seedCard = (firstVer?.prior_card as string | null) ?? null;
  if (!seedCard) {
    console.error("No prior_card in version log — cannot auto-restore. Aborting so nothing is lost.");
    process.exit(1);
  }
  console.log(`recovered original seed card (${seedCard.length} chars)`);

  // 2. Find the test lead.
  const { data: lead } = await db
    .from("leads")
    .select("id")
    .eq("agent_id", AGENT_ID)
    .eq("phone", TEST_PHONE)
    .maybeSingle();

  if (lead) {
    // FK: messages.lead_id references leads(id) → delete messages first.
    const { count } = await db
      .from("messages")
      .delete({ count: "exact" })
      .eq("agent_id", AGENT_ID)
      .eq("lead_id", lead.id);
    console.log(`deleted ${count ?? 0} test messages for lead ${lead.id}`);
    await db.from("memory").delete().eq("agent_id", AGENT_ID).eq("lead_id", lead.id);
    await db.from("leads").delete().eq("agent_id", AGENT_ID).eq("id", lead.id);
    console.log(`deleted test lead ${lead.id} (${TEST_PHONE})`);
  } else {
    console.log("test lead not found — already clean");
  }

  // 3. Remove ALL version-log rows for this agent (the test distill polluted it;
  //    prior_card is already recovered above, so this is safe).
  const { count: vCount } = await db
    .from("agent_persona_versions")
    .delete({ count: "exact" })
    .eq("agent_id", AGENT_ID);
  console.log(`deleted ${vCount ?? 0} version-log rows`);

  // 4. Compute the correct baseline watermark = max REAL outbound id (0 if none
  //    now that the test messages are gone), then restore the seed card at it.
  const { data: maxRow } = await db
    .from("messages")
    .select("id")
    .eq("agent_id", AGENT_ID)
    .eq("direction", "out")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  const baseline = (maxRow?.id as number | null) ?? 0;
  await db.from("agent_persona").upsert(
    { agent_id: AGENT_ID, voice_card: seedCard, card_upto: baseline, updated_at: new Date().toISOString() },
    { onConflict: "agent_id" },
  );
  console.log(`restored seed card; card_upto set to baseline max-outbound-id = ${baseline}`);

  // 5. Read-back proof.
  const { data: persona } = await db
    .from("agent_persona")
    .select("card_upto, updated_at, voice_card")
    .eq("agent_id", AGENT_ID)
    .maybeSingle();
  const { count: outCount } = await db
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", AGENT_ID)
    .eq("direction", "out");
  console.log("\n--- AFTER CLEANUP ---");
  console.log(`agent_persona.card_upto = ${persona?.card_upto}`);
  console.log(`agent_persona card_len  = ${(persona?.voice_card as string | null)?.length ?? 0} (should be 2158, the real seed)`);
  console.log(`outbound messages total = ${outCount ?? 0}`);
}

main().catch((e) => {
  console.error("cleanup failed:", e);
  process.exit(1);
});
