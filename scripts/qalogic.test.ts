// Offline self-check for the qa.ts answering logic (src/qa.ts): the qualified
// rule and the loose lead matcher the agent's "summarize Ahmed" relies on. The
// LLM intent classify is not exercised here (needs a live model); this guards the
// pure store→answer logic. No network — supabase-js is lazy, so dummy creds let
// the module import without opening a connection.
// Run: npx tsx scripts/qalogic.test.ts
import assert from "node:assert";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "dummy";

const { isQualified, findLead } = await import("../src/qa.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lead = (over: any) =>
  ({
    id: 1,
    agent_id: "agent_test",
    phone: "971500000001",
    name: null,
    stage: "first_contact",
    budget: null,
    area: null,
    requirement: null,
    status: "open",
    next_question: null,
    replies_json: null,
    summary: null,
    summary_upto: 0,
    updated_at: "",
    ...over,
  }) as any;

// --- isQualified: all three fields required ---
assert.strictEqual(isQualified(lead({ budget: "1.4M", area: "JVC", requirement: "buy · 2BR" })), true);
assert.strictEqual(isQualified(lead({ budget: "1.4M", area: "JVC", requirement: null })), false, "missing requirement");
assert.strictEqual(isQualified(lead({})), false, "empty lead");

// --- findLead: name substring, case-insensitive ---
const leads = [
  lead({ id: 1, name: "Ahmed Khan", phone: "971500000001" }),
  lead({ id: 2, name: "Sara", phone: "971581871500" }),
  lead({ id: 3, name: null, phone: "971509999999" }),
];
assert.strictEqual(findLead(leads, "ahmed")?.id, 1, "name substring, lowercased");
assert.strictEqual(findLead(leads, "Sara")?.id, 2, "exact name");

// --- findLead: phone-suffix match on >=4 digits ---
assert.strictEqual(findLead(leads, "+971 58 187 1500")?.id, 2, "full number with punctuation");
assert.strictEqual(findLead(leads, "9999")?.id, 3, "trailing digits match nameless lead");

// --- findLead: no match / too-short needle ---
assert.strictEqual(findLead(leads, "Bob"), undefined, "no name match");
assert.strictEqual(findLead(leads, "12"), undefined, "under 4 digits does not phone-match");
assert.strictEqual(findLead(leads, ""), undefined, "empty needle");

console.log("qa logic self-check passed");
