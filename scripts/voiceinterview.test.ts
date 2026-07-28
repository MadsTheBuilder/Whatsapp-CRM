import "dotenv/config"; // store.ts (transitively imported) throws at load without SUPABASE_*
import assert from "node:assert";
import { advance, TOTAL_SCENARIOS, interviewIntro } from "../src/voice-interview.js";
import type { InterviewState } from "../src/store.js";

// State-machine self-check for the WhatsApp voice interview. Pure logic only
// (advance + intro) — no DB, no model. Proves the walk from step 0 to done.

// Intro presents scenario 1 of N.
const intro = interviewIntro();
assert.ok(intro.includes(`Lead 1 of ${TOTAL_SCENARIOS}`), "intro shows first scenario");

// Walk the whole interview: each advance appends the reply, bumps the step, and
// only the final one flags done with cleared (null) state.
let state: InterviewState = { phase: "interviewing", step: 0, replies: [] };
for (let i = 0; i < TOTAL_SCENARIOS; i++) {
  const { next, botMessage, done } = advance(state, `reply ${i}`);
  const isLast = i === TOTAL_SCENARIOS - 1;
  assert.strictEqual(done, isLast, `done only on last (step ${i})`);
  if (isLast) {
    assert.strictEqual(next, null, "last advance clears state");
    assert.ok(/building your voice card/i.test(botMessage), "last message announces card build");
  } else {
    assert.ok(next, "non-last advance returns next state");
    assert.strictEqual(next!.step, i + 1, "step advances by 1");
    assert.strictEqual(next!.replies.length, i + 1, "reply captured");
    assert.ok(botMessage.includes(`Lead ${i + 2} of`), "presents the next scenario");
    state = next!;
  }
}

// The captured replies survive to the final extraction hand-off.
const walk: string[] = [];
let s: InterviewState = { phase: "interviewing", step: 0, replies: [] };
for (let i = 0; i < TOTAL_SCENARIOS; i++) {
  walk.push(`msg${i}`);
  const r = advance(s, `msg${i}`);
  if (r.next) s = r.next;
  else assert.deepStrictEqual(s.replies.concat("msg" + i), walk, "all replies present at wrap");
}

console.log(`voiceinterview: all assertions passed (${TOTAL_SCENARIOS} scenarios)`);
