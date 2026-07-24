import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const AGENT_ID = process.env.AGENT_ID ?? "agent_demo";
async function main() {
  const { data } = await db.from("agent_persona_versions").select("prior_card").eq("agent_id", AGENT_ID).order("created_at", { ascending: true }).limit(1).maybeSingle();
  const prior = data?.prior_card as string | null;
  console.log(`prior_card present: ${!!prior}  len: ${prior?.length ?? 0}`);
  console.log("--- first 400 chars of the SAVED original seed ---");
  console.log((prior ?? "(none)").slice(0, 400));
}
main().catch(e => { console.error(e); process.exit(1); });
