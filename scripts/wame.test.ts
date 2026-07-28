// Offline self-check for waMeLink — the pre-fill link builder behind the suggestion
// card. No network — dummy Supabase creds let the transitive store.ts import resolve.
// Run: npx tsx scripts/wame.test.ts
import assert from "node:assert";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "dummy";

const { waMeLink } = await import("../src/brain.js");

// Strips the leading +, URL-encodes space and & in the body.
assert.strictEqual(
  waMeLink("+971501234567", false, "Hi there & welcome!"),
  "https://wa.me/971501234567?text=Hi%20there%20%26%20welcome!",
  "must strip + and encode the reply body",
);

// @lid chat: leadNumber isn't a dialable phone → no link.
assert.strictEqual(waMeLink("somelid", true, "x"), null, "lid chats must not get a link");

// No digits at all → no link.
assert.strictEqual(waMeLink("", false, "x"), null, "empty number must not get a link");

console.log("wame.test.ts OK");
