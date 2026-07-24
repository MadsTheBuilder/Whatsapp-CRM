import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

// THROWAWAY: confirm the @lid link was learned on Madhur's lead. Delete after.
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
const AGENT_ID = process.env.AGENT_ID ?? "agent_demo";

async function main() {
  const { data } = await db
    .from("leads")
    .select("id,phone,lid,name,monitor")
    .eq("agent_id", AGENT_ID)
    .eq("phone", "919717662666")
    .maybeSingle();
  console.log("Madhur lead:", data);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
