import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

// THROWAWAY: dump the current voice card + the prior card from the last version
// row, so we can eyeball whether distill actually folded the agent's voice in.
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
const AGENT_ID = process.env.AGENT_ID ?? "agent_demo";

async function main() {
  const { data: persona } = await db
    .from("agent_persona")
    .select("voice_card, card_upto, updated_at")
    .eq("agent_id", AGENT_ID)
    .maybeSingle();
  const { data: ver } = await db
    .from("agent_persona_versions")
    .select("prior_card, from_upto, to_upto, sample_count, created_at")
    .eq("agent_id", AGENT_ID)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  console.log("========== PRIOR CARD (before this distill) ==========");
  console.log(ver?.prior_card ?? "(none)");
  console.log("\n\n========== CURRENT CARD (after distill fold) ==========");
  console.log(persona?.voice_card ?? "(none)");
  console.log("\n---");
  console.log(`card_upto=${persona?.card_upto}  folded ${ver?.sample_count} msgs (${ver?.from_upto}->${ver?.to_upto})`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
