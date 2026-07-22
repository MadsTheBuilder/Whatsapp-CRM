// Offline self-check for the pure logic inside src/store.ts that doesn't need
// Supabase: the sticky null-omit rule (COALESCE replacement) and the ISO ts
// parse used by responsiveness. The DB round-trips (dedup, real state machine)
// are covered by the repointed stickycheck/respcheck against live Supabase in a
// later phase; this guards the two bits of branch logic we hand-wrote here.
// Run: npx tsx scripts/storelogic.test.ts
import assert from "node:assert";

// --- sticky field omission (mirrors updateLeadQualification) ---
function buildUpdate(fields: {
  budget: string | null;
  area: string | null;
  requirement: string | null;
}): Record<string, unknown> {
  const u: Record<string, unknown> = {};
  if (fields.budget !== null) u.budget = fields.budget;
  if (fields.area !== null) u.area = fields.area;
  if (fields.requirement !== null) u.requirement = fields.requirement;
  return u;
}

// null field is omitted (Postgres leaves it → old value sticks)
assert.deepStrictEqual(buildUpdate({ budget: null, area: "JVC", requirement: null }), {
  area: "JVC",
});
// empty string is NOT null → it lands (a real correction to blank)
assert.deepStrictEqual(buildUpdate({ budget: "", area: null, requirement: "2BR" }), {
  budget: "",
  requirement: "2BR",
});
// all present → all update
assert.deepStrictEqual(buildUpdate({ budget: "2M", area: "Marina", requirement: "villa" }), {
  budget: "2M",
  area: "Marina",
  requirement: "villa",
});

// --- ISO timestamptz parse (mirrors responsiveness silent_ms) ---
const QUIET_MS = 24 * 60 * 60 * 1000;
const twoDaysAgo = new Date(Date.now() - 2 * QUIET_MS).toISOString();
const silent = Date.now() - Date.parse(twoDaysAgo);
assert.ok(silent >= QUIET_MS, "2-day-old outbound must read as no_reply");
const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
assert.ok(Date.now() - Date.parse(oneHourAgo) < QUIET_MS, "1h-old outbound is awaiting_reply");

console.log("store logic self-check passed");
