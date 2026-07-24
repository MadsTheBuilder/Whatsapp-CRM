// Offline self-check for the `stage <phone> <pipeline>` parser (src/company.ts).
// This is a free-text write boundary: a typed command moves a lead's funnel
// stage, so a malformed/typo'd command must fall through to Q&A (return null),
// never write a bad value. No network — dummy creds let the module import.
// Run: npx tsx scripts/stagelogic.test.ts
import assert from "node:assert";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "dummy";

const { parseStageCommand } = await import("../src/company.js");

// --- valid commands round-trip to phone + pipeline ---
assert.deepStrictEqual(parseStageCommand("stage 971500000001 meeting_done"), {
  phone: "971500000001",
  pipeline: "meeting_done",
});
assert.deepStrictEqual(parseStageCommand("STAGE 971500000001 EOI"), {
  phone: "971500000001",
  pipeline: "eoi",
}, "case-insensitive keyword + value");
assert.deepStrictEqual(parseStageCommand("  stage   971500000001   waste  "), {
  phone: "971500000001",
  pipeline: "waste",
}, "extra whitespace tolerated");

// --- rejected: falls through to Q&A ---
assert.strictEqual(parseStageCommand("how many qualified leads?"), null, "plain question");
assert.strictEqual(parseStageCommand("stage 971500000001"), null, "missing pipeline");
assert.strictEqual(parseStageCommand("stage 971500000001 bogus"), null, "unknown pipeline");
assert.strictEqual(parseStageCommand("stage 123 eoi"), null, "phone too short");
assert.strictEqual(parseStageCommand("stage 97150abc eoi"), null, "non-digit phone");
assert.strictEqual(parseStageCommand("stage 971500000001 eoi extra"), null, "trailing junk");
assert.strictEqual(parseStageCommand("stageeoi"), null, "no separator");

console.log("stage logic self-check passed");
