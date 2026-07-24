// Offline self-checks for the voice-card distill job. No network — dummy Supabase
// creds let store.ts import. Covers the pure pieces the distill loop composes:
// the self-imitation filter (must drop near-verbatim copies of our suggestions,
// or the card learns the AI's own voice back) and the threshold gate arithmetic.
// Run: npx tsx scripts/distill.test.ts
import assert from "node:assert";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "dummy";

const { normalizeForCopyCheck, filterVoiceSamples, DISTILL_BATCH_MAX } =
  await import("../src/store.js");
const { DISTILL_THRESHOLD } = await import("../src/distill.js");

// --- normalizeForCopyCheck: edits that shouldn't defeat copy-detection ---
const base = normalizeForCopyCheck("Let's book a viewing this week.");
assert.strictEqual(
  normalizeForCopyCheck("let's book a viewing this week"),
  base,
  "trailing period + case must normalize equal",
);
assert.strictEqual(
  normalizeForCopyCheck("Let's book a  viewing\nthis week."),
  base,
  "collapsed whitespace + linebreak must normalize equal",
);
assert.notStrictEqual(
  normalizeForCopyCheck("Let's book a viewing next week."),
  base,
  "genuinely different message must NOT collapse to the same key",
);

// --- filterVoiceSamples: a punctuation-edited copy of a suggestion is dropped ---
// suggested Set is normalized (as suggestedRepliesFor builds it).
const suggested = new Set([normalizeForCopyCheck("Let's book a viewing this week.")]);
const bodies = [
  "let's book a viewing this week", // copy w/ case+punct edit → must drop
  "Cash buyer? Then let's move fast.", // real agent voice → must keep
  "  Let's book a viewing this week.  ", // copy w/ whitespace → must drop
];
const kept = filterVoiceSamples(bodies, suggested, 10);
assert.deepStrictEqual(
  kept,
  ["Cash buyer? Then let's move fast."],
  "only the non-copy survives; both edited copies filtered",
);

// --- filterVoiceSamples: empty bodies skipped, limit respected ---
assert.deepStrictEqual(
  filterVoiceSamples(["a", "", "b", "c"], new Set(), 2),
  ["a", "b"],
  "blank skipped, cap at limit",
);

// --- threshold gate arithmetic (the shape maybeDistillVoiceCard uses) ---
// It distills iff samples.length >= DISTILL_THRESHOLD, NOT on (maxId - upto).
const gate = (sampleCount: number) => sampleCount >= DISTILL_THRESHOLD;
assert.strictEqual(gate(DISTILL_THRESHOLD - 1), false, "below threshold: skip");
assert.strictEqual(gate(DISTILL_THRESHOLD), true, "at threshold: distill");
assert.ok(DISTILL_THRESHOLD <= DISTILL_BATCH_MAX, "threshold must fit inside one batch");

console.log("distill self-checks passed");
