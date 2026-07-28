import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { resolveAgentByReadNumber, listAllAgents } from "../src/store.js";

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

(async () => {
  // Fix the typo'd `you` row: 11-digit "97581871500" -> 12-digit "971581871500"
  // (the number the Baileys QR is actually scanned with, per creds.json "me.id").
  const CORRECT = "971581871500";
  const { error } = await db
    .from("agents")
    .update({ read_number: CORRECT, send_number: CORRECT })
    .eq("agent_id", "you");
  if (error) throw error;

  const all = await listAllAgents();
  console.log("registry rows:", JSON.stringify(all, null, 2));
  const you = await resolveAgentByReadNumber(CORRECT);
  console.log(
    `resolve ${CORRECT} =>`,
    you ? `${you.agent_id} send=${you.send_number} ✅` : "NULL (would drop every message!)",
  );
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
