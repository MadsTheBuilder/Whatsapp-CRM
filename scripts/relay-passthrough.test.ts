import "dotenv/config";
import assert from "node:assert";
import { maybeRelayPortalLead } from "../src/portal/goyzer.js";
import type { Agent } from "../src/store.js";

// Regression check for the relay/brain split (src/pipe/dialog360.ts) AND the strict
// sender-gate: only a card FROM the agent's goyzer_number relays; everything else
// (ordinary text, OR a spoofed card from the wrong number) falls through to the brain.
// No sends / no DB writes here — the gate and parseGoyzerCard bail before any I/O.
//   npx tsx scripts/relay-passthrough.test.ts

const GOYZER = "97145689749";
const agent = { agent_id: "regression_check", name: "Mitko", goyzer_number: GOYZER } as Agent;
const NOT_GOYZER = "971500000009"; // a lead's number, not Goyzer

const card = `Hi Test\n\nYou have a new lead!\n\nLead Source: Propertyfinder\nTracking Link: http://127.0.0.1:1/nope\n\nClient Name: X\nNotes: LeadId : 1 https://propertyfinder.ae/go/ABC`;

// [text, sender, expectedHandled, label]
const cases: [string, string, boolean, string][] = [
  ["Looking for a 2BR in JVC, budget 1.4M", NOT_GOYZER, false, "ordinary text from lead → brain"],
  ["Hi, is the apartment still available?", NOT_GOYZER, false, "ordinary text from lead → brain"],
  ["You have a new lead", GOYZER, false, "near-miss shape (no '!') from Goyzer → brain"],
  [card, NOT_GOYZER, false, "SPOOFED card from wrong number → brain (gate blocks)"],
  [card, GOYZER, true, "real card from Goyzer → relay (caught, not brain)"],
];

(async () => {
  let pass = 0;
  for (const [text, sender, expected, label] of cases) {
    const handled = await maybeRelayPortalLead(agent, text, sender);
    const ok = handled === expected;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
    if (ok) pass++;
  }

  console.log(`\n${pass}/${cases.length} ${pass === cases.length ? "ALL PASSED" : "SOME FAILED"}`);
  assert.equal(pass, cases.length, "relay routing + sender-gate regression");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
