// Offline self-check for the reminder selection + digest logic (src/reminders.ts):
// which leads get chased (last direction "out", quiet > 3 days), the oldest-quiet
// ordering, and the digest text. The live store read is not exercised here — these
// are the pure functions the run wraps. No network — supabase-js is lazy, dummy
// creds let the module import.
// Run: npx tsx scripts/reminderlogic.test.ts
import assert from "node:assert";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "dummy";

const { selectStale, buildDigest } = await import("../src/reminders.js");

const DAY = 24 * 60 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lead = (over: any) =>
  ({
    id: 1, agent_id: "agent_test", phone: "971500000001", name: null,
    stage: "first_contact", budget: null, area: null, requirement: null,
    status: "open", next_question: null, replies_json: null, summary: null,
    summary_upto: 0, updated_at: "",
    ...over,
  }) as any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const state = (l: any, last_direction: any, silent_ms: any) => ({ lead: l, last_direction, silent_ms });

const ahmed = lead({ id: 1, name: "Ahmed", area: "JVC", requirement: "buy · 2BR" });
const sara = lead({ id: 2, name: "Sara", area: "Marina" });
const fresh = lead({ id: 3, name: "Fresh" });
const active = lead({ id: 4, name: "Active" });
const nomsg = lead({ id: 5, name: "Nomsg" });

const states = [
  state(ahmed, "out", 4 * DAY),   // stale — 4 days quiet, agent's court
  state(sara, "out", 5 * DAY),    // stale — 5 days quiet
  state(fresh, "out", 1 * DAY),   // NOT stale — under 3 days
  state(active, "in", null),      // NOT stale — lead spoke last (out of scope)
  state(nomsg, null, null),       // NOT stale — no messages
];

// --- selectStale: only >3-day outbound-last leads, oldest first ---
const stale = selectStale(states);
assert.strictEqual(stale.length, 2, "only Ahmed and Sara qualify");
assert.strictEqual(stale[0].lead.id, 2, "Sara (5 days) sorts before Ahmed (4 days)");
assert.strictEqual(stale[1].lead.id, 1, "Ahmed second");

// exact 3-day boundary does NOT qualify (strictly greater than STALE_MS)
assert.strictEqual(selectStale([state(ahmed, "out", 3 * DAY)]).length, 0, "exactly 3 days is not yet stale");

// --- buildDigest: names, tags, day count, and the header pluralization ---
const digest = buildDigest(stale);
assert.ok(digest, "digest present");
assert.ok(digest!.startsWith("2 leads need a nudge:"), `header: ${digest}`);
assert.ok(digest!.includes("Sara (Marina) — 5 days quiet"), "Sara line with area tag");
assert.ok(digest!.includes("Ahmed (JVC · buy · 2BR) — 4 days quiet"), "Ahmed line with area · requirement");

// --- singular header ---
const one = buildDigest(selectStale([state(sara, "out", 5 * DAY)]));
assert.ok(one!.startsWith("1 lead needs a nudge:"), `singular header: ${one}`);

// --- nameless lead falls back to phone ---
const anon = buildDigest(selectStale([state(lead({ phone: "971509999999" }), "out", 4 * DAY)]));
assert.ok(anon!.includes("971509999999 — 4 days quiet"), "phone fallback when no name");

// --- nothing stale → null (no message sent) ---
assert.strictEqual(buildDigest(selectStale([state(fresh, "out", 1 * DAY)])), null, "no stale leads → null");

console.log("reminder logic self-check passed");
