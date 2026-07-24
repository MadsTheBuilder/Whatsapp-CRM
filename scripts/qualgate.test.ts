// Offline self-checks for the phase-10 qualification gate: the list-row parser
// (src/company.ts, a write boundary — a bad id must never move a lead) and the
// budget guard (src/qualify.ts, strips the model's chain-of-thought out of the
// budget cell). No network — dummy creds let the modules import.
// Run: npx tsx scripts/qualgate.test.ts
import assert from "node:assert";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "dummy";

const { parseStageSelection } = await import("../src/company.js");
const { cleanBudget } = await import("../src/qualify.js");

// --- parseStageSelection: valid list-row ids round-trip ---
assert.deepStrictEqual(parseStageSelection("stage:919717662666:qualifies"), {
  phone: "919717662666",
  pipeline: "qualifies",
});
assert.deepStrictEqual(parseStageSelection("stage:971500000001:waste"), {
  phone: "971500000001",
  pipeline: "waste",
});

// --- parseStageSelection: rejected → falls through ---
assert.strictEqual(parseStageSelection("approve:919717662666"), null, "approval id, not a stage");
assert.strictEqual(parseStageSelection("stage:123:qualifies"), null, "phone too short");
assert.strictEqual(parseStageSelection("stage:97150abc:eoi"), null, "non-digit phone");
assert.strictEqual(parseStageSelection("stage:971500000001:bogus"), null, "unknown pipeline");
assert.strictEqual(parseStageSelection("stage:971500000001"), null, "missing pipeline part");
assert.strictEqual(parseStageSelection("stage:971500000001:eoi:extra"), null, "too many parts");
assert.strictEqual(parseStageSelection(""), null, "empty");

// --- cleanBudget: real values pass, reasoning prose is nulled ---
assert.strictEqual(cleanBudget("~AED 80k/yr"), "~AED 80k/yr", "clean value kept");
assert.strictEqual(cleanBudget("1.4M"), "1.4M");
assert.strictEqual(cleanBudget("8k/month"), "8k/month");
assert.strictEqual(cleanBudget(null), null, "null stays null");
assert.strictEqual(
  cleanBudget(
    "There is no concrete budget stated. However, the lead mentions an 'ideal' of around 80k per year, so I will record this as a range: [6670, 80000].",
  ),
  null,
  "chain-of-thought paragraph → null",
);
assert.strictEqual(cleanBudget("assume around 2 million"), null, "reasoning keyword → null");

console.log("qual-gate self-checks passed");
