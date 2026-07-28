// Offline self-check for the 360dialog agent-pipe parser (src/pipe/dialog360.ts):
// the direction mapping (in vs out) and the drop rules. No network — supabase-js is
// lazy, so dummy creds let the module import without opening a connection.
// Run: npx tsx scripts/dialog360parse.test.ts
import assert from "node:assert";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "dummy";
process.env.COMPANY_BOT_NUMBER = "971581137568"; // bot's own number — must be dropped both ways

const { toEvent } = await import("../src/pipe/dialog360.js");

// The one bit of real logic in the 360dialog agent pipe: mapping a raw message +
// its accompanying recipient to the brain's event shape, and getting direction right.
const AGENT = "971500000001";
const LEAD = "971500000002";

// Inbound: lead → agent. from = lead, no recipientId. direction "in", lead = sender.
{
  const ev = toEvent(
    { from: LEAD, id: "wamid.in", timestamp: "1700000000", type: "text", text: { body: " hi " } },
    "Rohan",
    AGENT,
    undefined,
  );
  assert(ev, "inbound text should produce an event");
  assert.equal(ev!.direction, "in");
  assert.equal(ev!.leadNumber, LEAD);
  assert.equal(ev!.text, "hi"); // trimmed
  assert.equal(ev!.timestamp, 1700000000 * 1000); // seconds → ms
  assert.equal(ev!.leadName, "Rohan");
  assert.equal(ev!.lid, undefined); // 360dialog never sets lid
  assert.equal(ev!.waId, "wamid.in");
}

// Outbound echo: agent → lead. from = agent, recipient rides on the status callback.
// direction "out", lead = the recipient (NOT from).
{
  const ev = toEvent(
    { from: AGENT, id: "wamid.out", timestamp: "1700000001", type: "text", text: { body: "here you go" } },
    "Rohan",
    AGENT,
    LEAD,
  );
  assert(ev, "outbound echo should produce an event");
  assert.equal(ev!.direction, "out");
  assert.equal(ev!.leadNumber, LEAD); // the recipient, not the agent
}

// Outbound echo with no recipient (couldn't read it off the status) → drop, don't
// key a lead on the agent's own number.
{
  const ev = toEvent(
    { from: AGENT, id: "x", timestamp: "1", type: "text", text: { body: "orphan" } },
    undefined,
    AGENT,
    undefined,
  );
  assert.equal(ev, null, "outbound with no recipient must drop");
}

// Non-text and empty-text drop.
assert.equal(
  toEvent({ from: LEAD, id: "x", timestamp: "1", type: "image" }, undefined, AGENT, undefined),
  null,
  "non-text drops",
);
assert.equal(
  toEvent({ from: LEAD, id: "x", timestamp: "1", type: "text", text: { body: "   " } }, undefined, AGENT, undefined),
  null,
  "whitespace-only text drops",
);

// Self-chat guard: the bot's own card (single-agent setup, agent==company number)
// arrives on this webhook as the bot number messaging the agent. Must drop, both
// directions — else the bot reads back its own suggestion and loops.
{
  // bot → agent (inbound-looking): from = bot number
  const inbound = toEvent(
    { from: "971581137568", id: "x", timestamp: "1", type: "text", text: { body: "suggested reply card" } },
    "bot",
    AGENT,
    undefined,
  );
  assert.equal(inbound, null, "bot's own card as inbound must drop");
  // agent → bot (outbound-looking): recipient = bot number
  const outbound = toEvent(
    { from: AGENT, id: "x", timestamp: "1", type: "text", text: { body: "reply to bot" } },
    "bot",
    AGENT,
    "971581137568",
  );
  assert.equal(outbound, null, "chat to the bot number must drop");
}

console.log("dialog360parse: all assertions passed");
