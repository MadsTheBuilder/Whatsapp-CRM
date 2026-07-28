// Offline self-check for the campaign-blast pure logic: CSV parsing, the
// newest-first + opt-out + dedup + limit pipeline (prepareBlast), and the opt-out
// message detector (company.ts). These are the quality-critical bits - a wrong sort
// blasts stale leads first, a missed opt-out filter re-messages someone who said
// STOP and tanks the rating. No network.
// Run: npx tsx scripts/blast.test.ts
import assert from "node:assert";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "dummy";

const { parseCsv, prepareBlast } = await import("./blast.js");
const { isOptOutMessage } = await import("../src/company.js");

// --- parseCsv: header-matched columns, phone cleaned, bad rows dropped ---
const csv = [
  "phone,name,inquiry_date,source",
  "+971 50 123 4567, Ahmed ,2026-06-28,Property Finder",
  "971559876543,Sara,2026-06-05,Meta Ad",
  ",Nobody,2026-06-10,X", // no phone -> dropped
  "notaphone,Bad,2026-06-11,X", // non-digits -> dropped
  "971501112222,Zed,2026-06-20,Bayut",
].join("\n");

const rows = parseCsv(csv);
assert.strictEqual(rows.length, 3, "two malformed rows dropped");
assert.strictEqual(rows[0].phone, "971501234567", "phone stripped of + and spaces");
assert.strictEqual(rows[0].name, "Ahmed", "name trimmed");
assert.strictEqual(rows[0].source, "Property Finder", "source parsed");

// --- parseCsv: source column absent -> source is empty (send falls back later) ---
const noSource = parseCsv("phone,name,inquiry_date\n971500000009,Kai,2026-06-15");
assert.strictEqual(noSource[0].source, "", "missing source column -> empty string");

// --- parseCsv: missing phone column is a hard error (not a silent empty blast) ---
assert.throws(() => parseCsv("name,inquiry_date\nAhmed,2026-06-01"), /phone/);

// --- prepareBlast: newest inquiry first (ramp), opt-out filtered, dup deduped ---
const optOuts = new Set<string>(["971559876543"]); // Sara opted out
const { toSend, skippedOptOut, skippedDup } = prepareBlast(rows, optOuts, 0);
assert.strictEqual(skippedOptOut, 1, "opted-out Sara skipped");
assert.strictEqual(toSend[0].phone, "971501234567", "newest (Jun 28) sorts first");
assert.strictEqual(toSend[1].phone, "971501112222", "Jun 20 second");
assert.strictEqual(toSend.length, 2, "3 rows - 1 opt-out = 2 sendable");

// --- prepareBlast: dedup a repeated phone ---
const dupRows = parseCsv(
  ["phone,name,inquiry_date", "971500000001,A,2026-06-10", "971500000001,A2,2026-06-11"].join("\n"),
);
const dedup = prepareBlast(dupRows, new Set(), 0);
assert.strictEqual(dedup.skippedDup, 1, "repeat phone deduped");
assert.strictEqual(dedup.toSend.length, 1, "one send for a duplicated number");

// --- prepareBlast: --limit caps the batch (the ramp control) ---
const capped = prepareBlast(rows, new Set(), 1);
assert.strictEqual(capped.toSend.length, 1, "limit 1 sends only the newest");
assert.strictEqual(capped.toSend[0].phone, "971501234567", "capped batch keeps newest-first");

// --- isOptOutMessage: typed keywords, button tap; ignores normal text ---
assert.strictEqual(isOptOutMessage({ type: "text", text: { body: "STOP" } }), true);
assert.strictEqual(isOptOutMessage({ type: "text", text: { body: " stop " } }), true);
assert.strictEqual(isOptOutMessage({ type: "text", text: { body: "unsubscribe" } }), true);
assert.strictEqual(
  isOptOutMessage({ type: "button", button: { text: "Stop promotions" } }),
  true,
  "template quick-reply opt-out button",
);
assert.strictEqual(
  isOptOutMessage({
    type: "interactive",
    interactive: { type: "button_reply", button_reply: { id: "x", title: "Stop promotions" } },
  }),
  true,
);
assert.strictEqual(
  isOptOutMessage({ type: "text", text: { body: "how many leads?" } }),
  false,
  "a normal agent question is not an opt-out",
);
assert.strictEqual(
  isOptOutMessage({ type: "text", text: { body: "please stop sending so many" } }),
  false,
  "STOP must be the whole message, not a substring",
);

console.log("\n✓ blast self-check passed: parse, sort, opt-out filter, dedup, limit, STOP detect");
