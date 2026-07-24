// Offline self-check for the Layer-3 voice-sample filter (src/store.ts,
// filterVoiceSamples). The money path: verbatim copies of OUR suggestions must be
// dropped, else the reply model learns to imitate its own AI voice. No network —
// dummy creds let store.ts import. Run: npx tsx scripts/voicesamples.test.ts
import assert from "node:assert";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "dummy";

const { filterVoiceSamples } = await import("../src/store.js");

const suggested = new Set(["Sounds good, shall I send the JVC floor plan?"]);

// Verbatim copy dropped; hand-typed kept; whitespace-trimmed match still counts.
assert.deepStrictEqual(
  filterVoiceSamples(
    [
      "give me a buzz when you're free",
      "  Sounds good, shall I send the JVC floor plan?  ", // copied suggestion (padded)
      "no worries, take your time 🙂",
    ],
    suggested,
    15,
  ),
  ["give me a buzz when you're free", "no worries, take your time 🙂"],
  "verbatim suggestion filtered, hand-typed kept",
);

// limit caps output; empty/whitespace bodies skipped.
assert.deepStrictEqual(
  filterVoiceSamples(["a", "", "  ", "b", "c"], new Set(), 2),
  ["a", "b"],
  "limit respected, blank bodies skipped",
);

console.log("✓ voicesamples passed: copies filtered, limit + blanks handled");
