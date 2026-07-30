import "dotenv/config";
import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";
import { maybeRelayPortalLead } from "../src/portal/goyzer.js";
import type { Agent } from "../src/store.js";

// LIVE end-to-end test of the Goyzer relay, runnable from any laptop (no tunnel /
// mini-PC — the tunnel only gates INBOUND webhooks; sendTemplate hits 360dialog's API
// and Supabase is cloud, both reachable from here). It DOES really send 3 WhatsApp
// templates and really writes a Supabase row, then verifies and cleans up.
//
// The lead phone is forced to the tester's own number by pointing the card's Tracking
// Link at a throwaway local server that 302s to wa.me/+<number>. This exercises the
// REAL resolveLeadPhone/fetch path unchanged — no production code touched — while
// guaranteeing only the tester's own number is ever messaged.

const TEST_PHONE = "971581871500"; // digits only, as the store keys it
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

// The listing link the lead will actually receive (PropertyFinder /go/ short link,
// from the real phase20 card). The tracking-link domain must never appear in a body.
const LISTING_LINK = "https://propertyfinder.ae/go/M58NKND7N0Z31STNGRFC9WPA6G";
const TRACKING_DOMAIN = "127.0.0.1"; // our local redirect host — must not leak into any body

function cardWithTrackingLink(trackingLink: string): string {
  return `Hi Test Agent

You have a new lead!

Lead Source: Propertyfinder
Campaign Name: NA
Tracking Link: ${trackingLink}

Client Name: E2E Test Lead
Client Phone # : Click On Tracking Link
Unit Reference # : AP26241
Property: Icon Tower 2
Community: Jumeirah Lake Towers
Unit details: NA

Notes: LeadId : 999999 ${LISTING_LINK}`;
}

async function hardDelete(agentId: string, phone: string) {
  const { data: leads } = await db.from("leads").select("id").eq("agent_id", agentId).eq("phone", phone);
  for (const l of leads ?? []) {
    await db.from("messages").delete().eq("agent_id", agentId).eq("lead_id", l.id);
  }
  await db.from("leads").delete().eq("agent_id", agentId).eq("phone", phone);
}

(async () => {
  // 1. Real agent. The strict sender-gate only relays for an agent with a goyzer_number
  // set, so pick that agent (not just the first row — the dev row has none).
  const { data: agents } = await db
    .from("agents")
    .select("agent_id, read_number, send_number, name, goyzer_number")
    .not("goyzer_number", "is", null);
  const agent = agents?.[0] as Agent | undefined;
  if (!agent) throw new Error("no agent with a goyzer_number set — the relay gate would block every card");
  console.log(`agent: ${agent.agent_id} (${agent.name ?? "?"}), goyzer_number=${agent.goyzer_number}`);
  // The gate requires the card to come FROM the agent's goyzer_number — use it as sender.
  const GOYZER_SENDER = agent.goyzer_number!;

  // 2. Local server that 302s the resolver to wa.me/+<tester number>.
  const server = createServer((_req, res) => {
    res.writeHead(302, { location: `https://wa.me/+${TEST_PHONE}` });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const trackingLink = `http://127.0.0.1:${port}/track`;

  try {
    // 3. Pre-clean: remove any existing lead on the test number (per instruction).
    await hardDelete(agent.agent_id, TEST_PHONE);
    console.log(`pre-clean done for ${TEST_PHONE}`);

    // 4. FIRST relay — should send 3 templates + seed one approved lead.
    console.log("\n--- run 1 (expect: 3 sends, 1 approved lead, 3 out rows) ---");
    const handled1 = await maybeRelayPortalLead(agent, cardWithTrackingLink(trackingLink), GOYZER_SENDER);
    console.log("returned:", handled1);

    // 5. Verify the seed.
    const { data: lead } = await db
      .from("leads")
      .select("id, phone, monitor, name")
      .eq("agent_id", agent.agent_id)
      .eq("phone", TEST_PHONE)
      .maybeSingle();
    console.log("lead row:", JSON.stringify(lead));
    const { data: msgs } = await db
      .from("messages")
      .select("direction, body")
      .eq("agent_id", agent.agent_id)
      .eq("lead_id", lead?.id ?? -1);

    const outRows = (msgs ?? []).filter((m) => m.direction === "out");
    const leaks = outRows.filter((m) => m.body.includes(TRACKING_DOMAIN));

    const checks = [
      ["lead exists", !!lead],
      ["monitor === approved", lead?.monitor === "approved"],
      ["exactly 3 out rows", outRows.length === 3],
      ["no tracking-domain leak in any body", leaks.length === 0],
    ] as const;

    // 6. SECOND relay — dedup: must NOT send or seed again.
    console.log("\n--- run 2 (expect: dedup, no new rows) ---");
    const handled2 = await maybeRelayPortalLead(agent, cardWithTrackingLink(trackingLink), GOYZER_SENDER);
    console.log("returned:", handled2);
    const { data: msgs2 } = await db
      .from("messages")
      .select("id")
      .eq("agent_id", agent.agent_id)
      .eq("lead_id", lead?.id ?? -1);
    const dedupOk = (msgs2?.length ?? 0) === outRows.length; // no new rows added

    console.log("\n=== RESULTS ===");
    for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    console.log(`${dedupOk ? "PASS" : "FAIL"}  run 2 added no new message rows (dedup)`);
    console.log("\nstored out-row bodies (this is exactly what was recorded):");
    for (const m of outRows) console.log("  -", m.body);

    const allPass = checks.every(([, ok]) => ok) && dedupOk;
    console.log(`\n${allPass ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);
    console.log("\n>>> Check your WhatsApp (+" + TEST_PHONE + ") — 3 templates should have arrived in order.");

    // 7. Cleanup.
    await hardDelete(agent.agent_id, TEST_PHONE);
    console.log("cleanup done — test lead + messages removed from Supabase.");
    if (!allPass) process.exit(1);
  } finally {
    server.close();
  }
})().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
