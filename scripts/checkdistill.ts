import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

// THROWAWAY read-only check of distill state in live Supabase. Delete after.
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
const AGENT_ID = process.env.AGENT_ID ?? "agent_demo";

async function main() {
  const { data: persona } = await db
    .from("agent_persona")
    .select("*")
    .eq("agent_id", AGENT_ID)
    .maybeSingle();
  console.log("=== agent_persona ===");
  console.log(
    persona
      ? {
          card_upto: persona.card_upto,
          updated_at: persona.updated_at,
          has_card: !!persona.voice_card,
          card_len: persona.voice_card?.length ?? 0,
        }
      : "(no row — card never seeded)",
  );

  const { data: versions } = await db
    .from("agent_persona_versions")
    .select("from_upto,to_upto,sample_count,created_at")
    .eq("agent_id", AGENT_ID)
    .order("created_at", { ascending: false })
    .limit(5);
  console.log("\n=== agent_persona_versions (distill audit log) ===");
  console.log(versions?.length ? versions : "(no rows — distill has NEVER run/saved)");

  const { count: outCount } = await db
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", AGENT_ID)
    .eq("direction", "out");
  console.log(`\n=== outbound messages total: ${outCount ?? 0} ===`);

  const { data: recentOut } = await db
    .from("messages")
    .select("id,lead_id,body,ts")
    .eq("agent_id", AGENT_ID)
    .eq("direction", "out")
    .order("id", { ascending: false })
    .limit(6);
  console.log("recent outbound (newest first):");
  for (const m of recentOut ?? [])
    console.log(`  id=${m.id} lead=${m.lead_id} "${(m.body as string).slice(0, 50)}" ${m.ts}`);
}

main().catch((e) => {
  console.error("check failed:", e);
  process.exit(1);
});
