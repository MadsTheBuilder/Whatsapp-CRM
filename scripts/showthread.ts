import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

// THROWAWAY: dump lead 13 (Madhur) stored suggested replies + qual. Delete after.
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
const AGENT_ID = process.env.AGENT_ID ?? "agent_demo";

async function main() {
  const { data: lead, error } = await db
    .from("leads")
    .select("id,name,replies_json,next_question,budget,area,requirement,stage,updated_at")
    .eq("agent_id", AGENT_ID)
    .eq("id", 13)
    .single();
  if (error) return console.log("error:", error.message);

  console.log(`=== Madhur (lead ${lead.id}) — last generated suggestion ===`);
  console.log(`updated_at: ${lead.updated_at}`);
  console.log(`stage: ${lead.stage}   next_question: ${lead.next_question}`);
  console.log(`qual: budget=${lead.budget} area=${lead.area} req=${lead.requirement}\n`);
  console.log("SUGGESTED REPLIES (what was DM'd to the agent):");
  const reps = (lead.replies_json ? JSON.parse(lead.replies_json as string) : []) as string[];
  if (!reps.length) console.log("  (none stored)");
  reps.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
