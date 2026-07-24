# HANDOFF — Phase 14: @lid live-verified end-to-end + model swap + reply-quality goal

Date: 2026-07-24
Branch: master
Status: **@lid outbound-capture PROVEN live end-to-end. Distill re-proven live. Model swapped
gemma4:12b → llama3.1:8b (11× faster). LLM path hardened (retry + timeout). NEXT: tune
suggestReplies() so all 4 options hit the quality of the best one, not 1 of 4.**

## The one thing to do next session (the actual ask)

**Make all 4 suggested replies as good as the best one.** In the live test the 4 options for
Madhur's negotiation moment were:
1. "ok no rush at all just curious — looking to move soon or more exploring for now?"
2. "got it so november 1st is still the target move-in date then"
3. **"more over i can definitely try negotiating with the landlord again what do you think about that"**  ← the good one
4. "please let me know if that fits your budget of 85k we can discuss further"

Only ~1 of 4 (#3) was genuinely appropriate to the situation. **The user wants ALL 4 at that
quality** — sharp, situation-aware, usable — each from a **different angle**. This is NOT a request
to narrow all 4 to one situation (user was explicit: "I don't want it narrowed down to a certain
situation"). It's: keep the 4 different angles, but every angle should be *relevant and high-quality*,
not a scattered mix where 3 miss.

The lever is the SYSTEM prompt in [src/replies.ts](../src/replies.ts) (lines 8-35) and its policy
skill [.claude/skills/reply-persona/SKILL.md](../.claude/skills/reply-persona/SKILL.md) — **read the
skill first, it's mandated by the prompt comment and by CLAUDE-style policy.** Likely cause of the
scatter: the prompt pushes "discovery-first" + "vary the 4 / genuine choice" so hard that on a
`deep`-stage, fully-qualified lead it still spends options on discovery questions (#1) and
fact-restatement (#4) instead of 4 strong situation-aware angles. Tuning should probably make the
discovery pressure *stage-aware* (ease off once budget/area/requirement are all filled) without
breaking the grounding rules (never re-ask an ANSWERED fact, never assert an UNKNOWN one).

**Caveat before tuning:** part of the scatter may be the smaller/faster model (llama3.1:8b) following
the prompt less tightly than a bigger one would. Consider setting `REPLY_MODEL` to a bigger model for
the voice-critical reply call only (the code already supports this — [claude.ts:39](../src/claude.ts#L39),
routed at [replies.ts:125](../src/replies.ts#L125)) and A/B by ear before over-editing the prompt.

## Also found (real bug, not yet fixed): stale next_question

For qualified lead 13 (budget=85k, area=JVC, rent/apartment/1BR, stage=deep), qualify produced:
`next_question: "Hello! Are you looking to buy or rent in Dubai?"` — a cold-open greeting for a
deep-stage lead. That's wrong. Investigate [src/qualify.ts](../src/qualify.ts) next_question logic /
stage-gating. The reply-persona skill also governs this (see its "Why discovery comes before
suggestion"). Lower priority than the reply-quality ask, but note it.

## What was PROVEN live this session (the big win)

**@lid outbound-capture works end-to-end** — the exact scenario that dropped 4/4 before:
- Client (Madhur, @lid `7232909500553`, phone `919717662666`) sent 1 message IN → brain resolved by
  phone, and `setLeadLid` stored the lid on lead 13. Verified in DB: `lead 13 lid=7232909500553`.
- Agent sent 4 messages OUT, ALL arriving lid-only (`senderPn=NONE`) → all 4 STORED, zero drops
  (`[brain] stored out-msg for 7232909500553` ×4). Before the fix these were dropped.
- Distill fired: `[distill] agent_demo saved: folded 4 msgs, 0→52`. DB confirmed: `card_upto 0→52`,
  new `agent_persona_versions` row `sample_count:4 from_upto:0 to_upto:52`, card rewritten
  (2158→1948 chars) folding the agent's REAL broker voice + PII redacted to `[Amount]`/`[Location]`
  and self-imitation examples updated. Verified via `scripts/showcard.ts` (prior vs current card).

So Phase 13's remaining work is DONE and PROVEN. The @lid fix + distill loop are both live-verified.

## Model swap (do NOT revert without reading this)

`gemma4:12b` was unusably slow (78s bare ping; full reply chain = minutes) AND flaky (returned empty
bodies under load, and once hung with no timeout → silent stall, no card sent). This is why the FIRST
live inbound produced no suggestion — not a pipe bug.

Fixed by: **pulled `llama3.1:8b` and set `MODEL=llama3.1:8b` in `.env`** (7s warm ping, ~11× faster;
it's also the code's documented default fallback). This is the ONLY realistic local model change —
`gemma4:12b` and `llama3.1:8b` are the only two installed in Ollama. Reply chain now completes in
seconds and cards arrive. **Trade-off: llama3.1:8b may follow the reply prompt less precisely than a
bigger model — this is a prime suspect for the reply-scatter above.**

## LLM path hardened — [src/claude.ts](../src/claude.ts) `ollamaStructured()`

Root-cause fix (one guard, all callers — qualify/summarize/replies/distill):
- **120s `AbortSignal.timeout` on the Ollama fetch** — a wedged model was hanging the whole inbound
  forever with no throw and no log (the silent-stall failure mode seen live). Now it's a catchable error.
- **3 retries with backoff** on empty/error — transient empties no longer silently kill a suggestion.
`npx tsc --noEmit` clean after both edits.

## Live-verified conversation state (for context next session)

Lead 13 (Madhur) now has a 14-message thread (ids 31-55): early qualifying msgs (31-36), the test
outbounds (49-52), then negotiation inbounds (53 "won't go above 85k", 54 "can we negotiate", 55
"Hello"). `summary_upto=55` — everything is folded into summary now. Windowing confirmed working:
`SUMMARIZE_AFTER=6`, `RECENT_WINDOW=6` ([brain.ts:25,30](../src/brain.ts#L25)); last reply saw ids
50-55 verbatim + summary of the rest, and DID reference summarized-only facts (Nov 1 move-in from id
34, outside the window) — so context/memory is working correctly. The reply-quality issue is about
angle selection, NOT missing context.

## Environment state (prototype — restore before prod)

- `.env`: `MODEL=llama3.1:8b` (changed this session), `MODEL_FALLBACKS=` empty, `DISTILL_THRESHOLD=4`
  (restore to 20 / delete for prod), `PORT=3001`.
- Server currently RUNNING in background on :3001, `[baileys] connected`, PID was 52972 (will be dead
  by next session — just `npm start` again). Don't open WhatsApp Web on the agent's number while
  Baileys is connected (causes logout).
- Migration 007 (`lid` column) + distill migration 006 already applied to live DB (user confirmed).
- Distill test residue was CLEANED this session (`scripts/distill-cleanup.ts` ran: restored the real
  2158-char seed, deleted old test lead 19 + msgs). Then the live test folded the real voice into it.

## Throwaway scripts on disk (all in scripts/, gitignored-ish — clean up eventually)

- KEEP for reply-quality work: `scripts/showthread.ts` (dumps a lead's thread + windowing + stored
  `replies_json`), `scripts/checkdistill.ts`, `scripts/showcard.ts`.
- Done with: `scripts/checklid.ts`, `scripts/distill-cleanup.ts`, `scripts/distill-live.ts`,
  `scripts/checkprior.ts`, `scripts/modelping.ts` — safe to delete.
- NOTE: `replies` is stored as `leads.replies_json` (a JSON string), NOT a `replies` column — parse it.
  `showthread.ts` selects lead 13 by id (`.eq("id",13)`); `.maybeSingle()` on `.eq("lid",...)` flaked.

## Loose ends carried over / still true

- Two `ponytail: diag` log lines still in [src/pipe/baileys.ts](../src/pipe/baileys.ts) (the `toEvent`
  line ~L92 and the firehose `events:` line ~L134-137) + the raw upsert line ~L172. The @lid path is
  now confirmed live, so these CAN be removed. User was asked (keep toEvent / remove 2 noisy ones was
  recommended) but pivoted to the reply-quality topic before answering — still open.
- Rejected @lid contacts (Nina `252445427036290`, others) correctly drop with
  `[brain] drop ... monitor=rejected`. Baileys re-delivers the same message repeatedly on reconnect —
  harmless since they're dropped, but it's log noise.

## Next session should start with
1. `npm start` (port 3001), confirm `[baileys] connected`.
2. Read `.claude/skills/reply-persona/SKILL.md` FIRST (mandated).
3. Decide model: try `REPLY_MODEL=<bigger>` for the reply call vs. tuning the prompt — A/B by ear.
4. Tune [src/replies.ts](../src/replies.ts) SYSTEM prompt so all 4 options are situation-aware +
   high-quality with different angles (make discovery-first pressure stage-aware; keep grounding rules).
   Test with a live Madhur message + `npx tsx scripts/showthread.ts` to read the 4 stored replies.
5. (Lower prio) fix the stale `next_question` cold-open on qualified deep-stage leads in qualify.ts.
