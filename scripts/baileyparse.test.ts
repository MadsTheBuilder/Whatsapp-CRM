// Offline self-check for the Baileys → AgentMessageEvent parser (src/pipe/baileys.ts):
// the JID→number strip, text extraction, and the drop rules (groups, status,
// non-text) that decide what ever reaches the brain. No network — supabase-js is
// lazy, so dummy creds let the module import without opening a connection.
// Run: npx tsx scripts/baileyparse.test.ts
import assert from "node:assert";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "dummy";
process.env.AGENT_ID = "agent_test";

const { toEvent, jidToNumber, messageText } = await import("../src/pipe/baileys.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mk = (over: any) => ({ key: {}, message: {}, ...over } as any);

// --- jidToNumber: strip @suffix and any :device part ---
assert.strictEqual(jidToNumber("971581871500@s.whatsapp.net"), "971581871500");
assert.strictEqual(jidToNumber("971581871500:12@s.whatsapp.net"), "971581871500");

// --- messageText: both plain and extended text carriers ---
assert.strictEqual(messageText(mk({ message: { conversation: "hi" } })), "hi");
assert.strictEqual(
  messageText(mk({ message: { extendedTextMessage: { text: "yo" } } })),
  "yo",
);
assert.strictEqual(messageText(mk({ message: { imageMessage: {} } })), "");

// --- toEvent: an inbound lead text becomes an "in" event ---
const inbound = toEvent(
  mk({
    key: { remoteJid: "971500000001@s.whatsapp.net", fromMe: false, id: "AAA" },
    message: { conversation: "Looking for a 2BR in JVC" },
    messageTimestamp: 1_700_000_000,
    pushName: "Ahmed",
  }),
);
assert.deepStrictEqual(inbound, {
  agentId: "agent_test",
  leadNumber: "971500000001",
  direction: "in",
  text: "Looking for a 2BR in JVC",
  timestamp: 1_700_000_000_000,
  waId: "AAA",
  leadName: "Ahmed",
});

// --- toEvent: a @lid message resolves the real phone from senderPn ---
const lidEvent = toEvent(
  mk({
    key: {
      remoteJid: "7232909500553@lid",
      senderPn: "919717662666@s.whatsapp.net",
      fromMe: false,
      id: "LID1",
    },
    message: { conversation: "Hi, looking for a 2BR in JVC" },
    messageTimestamp: 1_700_000_000,
    pushName: "Madhur",
  }),
);
assert.strictEqual(lidEvent?.leadNumber, "919717662666", "@lid resolves phone from senderPn");
assert.strictEqual(lidEvent?.direction, "in");

// --- toEvent: @lid with no senderPn falls back to the lid's own id (still a valid key) ---
assert.strictEqual(
  toEvent(
    mk({
      key: { remoteJid: "7232909500553@lid", fromMe: false, id: "LID2" },
      message: { conversation: "hello" },
      messageTimestamp: 1_700_000_000,
    }),
  )?.leadNumber,
  "7232909500553",
  "@lid without senderPn falls back to the lid id",
);

// --- toEvent: fromMe → "out" (agent's own reply) ---
assert.strictEqual(
  toEvent(
    mk({
      key: { remoteJid: "971500000001@s.whatsapp.net", fromMe: true, id: "BBB" },
      message: { conversation: "sure, calling you now" },
      messageTimestamp: 1_700_000_100,
    }),
  )?.direction,
  "out",
);

// --- toEvent drops: group, status broadcast, empty/non-text ---
assert.strictEqual(
  toEvent(mk({ key: { remoteJid: "12345-678@g.us" }, message: { conversation: "hey all" } })),
  null,
  "group chat must drop",
);
assert.strictEqual(
  toEvent(mk({ key: { remoteJid: "status@broadcast" }, message: { conversation: "my status" } })),
  null,
  "status broadcast must drop",
);
assert.strictEqual(
  toEvent(mk({ key: { remoteJid: "971500000001@s.whatsapp.net" }, message: { imageMessage: {} } })),
  null,
  "non-text (image) must drop",
);
assert.strictEqual(
  toEvent(mk({ key: { remoteJid: "971500000001@s.whatsapp.net" }, message: { conversation: "   " } })),
  null,
  "whitespace-only must drop",
);

console.log("baileys parse self-check passed");
