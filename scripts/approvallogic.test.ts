// Offline self-check for the approval-button id parser (src/company.ts). This is
// the gate's trust boundary: a tapped Yes/No button's id decides whether a number
// gets monitored, so a malformed/spoofed id must NEVER flip a random number's
// state. No network — supabase-js is lazy, so dummy creds let the module import.
// Run: npx tsx scripts/approvallogic.test.ts
import assert from "node:assert";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "dummy";

const { parseApprovalId, isVoiceCommand } = await import("../src/company.js");

// --- valid buttons round-trip to a decision + phone ---
assert.deepStrictEqual(parseApprovalId("approve:971500000001"), {
  monitor: "approved",
  phone: "971500000001",
});
assert.deepStrictEqual(parseApprovalId("reject:971500000001"), {
  monitor: "rejected",
  phone: "971500000001",
});

// --- rejected: not one of our buttons ---
assert.strictEqual(parseApprovalId("yes:971500000001"), null, "unknown decision word");
assert.strictEqual(parseApprovalId("approve:"), null, "empty phone");
assert.strictEqual(parseApprovalId("approve"), null, "no separator");
assert.strictEqual(parseApprovalId(""), null, "empty id");
assert.strictEqual(parseApprovalId("approve:97150abc001"), null, "non-digit phone");
assert.strictEqual(parseApprovalId("approve:123"), null, "phone too short for E.164");
assert.strictEqual(
  parseApprovalId("approve:971500000001@s.whatsapp.net"),
  null,
  "jid suffix is not a bare phone",
);

// --- isVoiceCommand: tolerant of real-keyboard whitespace/case (the exact /^voice$/
// match silently fell through to Q&A when the body wasn't bit-exact) ---
assert.strictEqual(isVoiceCommand("voice"), true);
assert.strictEqual(isVoiceCommand("Voice"), true, "case-insensitive");
assert.strictEqual(isVoiceCommand("  voice  "), true, "trims surrounding whitespace");
assert.strictEqual(isVoiceCommand("VOICE\n"), true, "trailing newline + caps");
assert.strictEqual(isVoiceCommand("learn my voice"), true, "alias");
assert.strictEqual(isVoiceCommand("voice interview"), true, "alias");
assert.strictEqual(isVoiceCommand("how many leads?"), false, "a real question is not the trigger");
assert.strictEqual(isVoiceCommand("voicemail"), false, "substring must not match");

console.log("approval logic self-check passed");
