import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

// Throwaway: clear stuck PENDING leads for one agent so a re-sent message re-fires
// the approval card. Only touches monitor='pending' — approved/rejected leads keep
// their transcript. Used to reset after the window-closed askApproval failures.
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

(async () => {
  const agentId = process.argv[2] ?? "mitko";
  const { data: before } = await db
    .from("leads")
    .select("phone, name, monitor")
    .eq("agent_id", agentId)
    .eq("monitor", "pending");
  console.log(`pending leads for ${agentId}:`, JSON.stringify(before, null, 2));

  const { data, error } = await db
    .from("leads")
    .delete()
    .eq("agent_id", agentId)
    .eq("monitor", "pending")
    .select("phone");
  if (error) throw error;
  console.log(`deleted ${data?.length ?? 0} pending row(s).`);
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
