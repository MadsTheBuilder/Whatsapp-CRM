// Offline self-check for the Layer-2 voice-card block (src/replies.ts). The one
// branch that matters: an empty/whitespace card must no-op (cold-start = today's
// behavior, zero regression), a real card must be wrapped in newlines so it slots
// into the prompt cleanly. No network — dummy creds let the module import.
// Run: npx tsx scripts/voicecard.test.ts
import assert from "node:assert";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "dummy";

const { voiceCardBlock } = await import("../src/replies.js");

// Cold start: no card → no-op (generic fallback, never worse than today).
assert.strictEqual(voiceCardBlock(""), "", "empty card no-ops");
assert.strictEqual(voiceCardBlock("   \n  "), "", "whitespace-only card no-ops");

// Real card → wrapped in leading/trailing newlines, content trimmed & intact.
const card = "VOICE (from onboarding):\n- length/rhythm: short, warm";
assert.strictEqual(voiceCardBlock(card), `\n${card}\n`, "real card wrapped in newlines");
assert.strictEqual(voiceCardBlock(`  ${card}  `), `\n${card}\n`, "surrounding whitespace trimmed");

console.log("voice-card self-check passed");
