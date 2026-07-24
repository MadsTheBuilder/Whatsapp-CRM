# HANDOFF — Phase 11: personalized replies — input-contract fix + Layer 3 + model routing

Date: 2026-07-23
Branch: master

## TL;DR

Continued the [personal-feat-brainstorm.md](personal-feat-brainstorm.md) build. Shipped and
**live-verified** the first two items of the ADJUSTED BUILD ORDER (model routing + Layer 3) **plus the
input-contract fix** that was the real root cause behind the "November screenshot" bug (replies
re-asking answered questions / asserting unstated facts).

**DONE + verified live this session:**
- **Input-contract fix** — `suggestReplies()` now receives ALL answered qualification fields as an
  explicit `ANSWERED (never re-ask)` / `UNKNOWN (never assert)` split, not just 3 of 7. Hard grounding
  rule added to the SYSTEM prompt keyed off those lists.
- **New `timeline` field** in qualify — was tracked NOWHERE before, which is why "move in November,
  contract ends then" got re-asked. Extracted passively (never interrogated). New DB column.
- **Layer 3 (live voice samples)** — agent's own recent outbound texts injected as few-shot so replies
  mirror THIS agent's voice. Verbatim copies of our OWN past suggestions filtered out (so it doesn't
  learn its own AI voice).
- **Model routing** — `REPLY_MODEL` env routes the voice-critical reply call to its own model;
  qualify/summarize stay on `MODEL`. (Currently single-model: both = `gemma4:12b`.)

**Environment set up this session:**
- Ollama upgraded 0.24.0 → 0.32.3 (old version couldn't pull gemma4:12b — 412 error).
- `gemma4:12b` (7.6 GB) pulled. **All other models deleted** (gemma4:26b, gemma4:e4b, llama3.1:8b) —
  single-model setup by user request. `.env` has `MODEL=gemma4:12b`; `REPLY_MODEL` unset (reply falls
  back to MODEL — same model, fine).
- Migration `004_add_timeline.sql` **applied to live Supabase** (user ran it).

Nothing running. Server stopped. Changes are in the working tree, **NOT git-committed**.

---

## Live verification (npm run repro) — PASS on the contract fix

Played the exact screenshot conversation (rent 1BR JVC → 90k/yr → "move in November, contract ends
then") through the real brain on gemma4:12b. Result:

- **Extraction:** budget=90k/yr, area=JVC, deal_type=rent, unit_type=apartment, beds=1BR,
  **timeline="November, preferably the 1st" ✅** (the field that didn't exist before).
- **Replies:** none re-asked when/why they're moving (old bug — now *reflects* it back instead). None
  asserted an area/property/amenity the lead never named. Discovery question (#2 asks about gym/pool as
  must-have) is correct, not an assertion.

**Two known cosmetic glitches in the model output** (NOT the contract fix — model artifacts):
- `"orlayout"` (missing space) — gemma4:12b token glitch.
- `"Hi [Name]"` — an unfilled placeholder leaked into a reply. Card builder should guard/strip literal
  `[Name]` before the agent sees it. (See TODO below.)

**Voice still reads slightly generic/agenty.** EXPECTED: Layer 3 had nothing to mirror — the repro
injects only inbound lead messages, zero agent OUTBOUND, so `recentAgentSamples()` returned empty and
fell back to the generic voice. Cold-start path working as designed. Voice won't personalize until
real agent-sent texts accumulate. **Layer 3 has NOT been verified with actual samples yet** (see TODO).

---

## Files touched this session (working tree, not committed)

- `src/qualify.ts` — added `timeline` to `Qualification` + `RawQualification` + SCHEMA + SYSTEM
  (extract-only, passive) + return mapping.
- `src/replies.ts` — replaced `knownFields()` (3 fields) with `groundingBlock()` (ANSWERED/UNKNOWN over
  6 discrete fields); added `samplesBlock()` (Layer 3); widened `suggestReplies()` signature to take
  `samples: string[]`; routes call through `REPLY_MODEL`; SYSTEM prompt rewritten with the hard
  grounding rule + voice-mirroring instruction. (Persona policy: `.claude/skills/reply-persona/SKILL.md`.)
- `src/store.ts` — `timeline` on `Lead` + in `updateLeadQualification` (sticky); new
  `recentAgentSamples()` + pure `filterVoiceSamples()` (exported for the self-check).
- `src/brain.ts` — fetches samples, passes them + `timeline` through.
- `src/claude.ts` — `structured()` takes optional per-call `model`; exported `REPLY_MODEL`.
- `supabase/schema.sql` — `timeline` column (fresh projects).
- `supabase/migrations/004_add_timeline.sql` (new) — **applied to live DB**.
- `.env.example` — documented `REPLY_MODEL`.
- `scripts/simulate.ts` — prints `timeline`.
- `scripts/repro-november.ts` (new) + `npm run repro` — replays the screenshot conversation live.
- `scripts/voicesamples.test.ts` (new) — offline self-check for the verbatim-copy filter (PASSES).
- `scripts/stickycheck.ts` — added `timeline: null` to its 3 update calls (typecheck fix).

`npx tsc --noEmit` clean. `voicesamples` + `qualgate` tests pass.

---

## TODO — what's left (in priority order)

### Immediate / small
1. **Guard the `[Name]` placeholder leak** — a reply came back literally as "Hi [Name], …". The card
   builder ([src/brain.ts](../src/brain.ts) `card` assembly ~L165) or `suggestReplies` should
   strip/guard leaked placeholders (`[Name]`, `[name]`, etc.) before the agent sees them. Small.

### Verify before building more
2. **Verify Layer 3 with REAL samples** — the only untested piece. Extend `repro` (or a new script) to
   seed a few agent OUTBOUND messages in a distinct voice FIRST, then generate, and confirm the replies
   actually mirror that voice. Until this is done, "does personalization work" is unproven — the repro
   only exercised the cold-start fallback.

### Next build items (from personal-feat-brainstorm.md ADJUSTED BUILD ORDER)
3. **Layer 2 — voice card + distill job** (#3 on the list). New `agent_persona` table keyed by
   `agent_id` (one row), INCLUDING nullable Layer-1 columns (tone/emoji/languages/sign-off/notes) so
   adding the onboarding form later is data-entry not a migration. Distill job mirrors the existing
   `summarize()` fold-in: reads real sent msgs, folds only messages since a `voice_card_upto`
   watermark into the card (flat cost). Triggered on threshold or the daily reminder cron. Then
   prepend the voice card to the reply prompt (cold-start → Layer 3 samples → generic).
   ⚠️ Same self-imitation caveat as Layer 3: don't distill from messages copied verbatim from our
   suggestions (reuse the `filterVoiceSamples` idea).
4. **Workstream B — response-rate labeling** (#4). Mark each suggested reply got-reply / no-reply
   (derivable from `responsiveness()` + whether the lead's next message was inbound). Data you can't
   backfill — every unlogged day is lost. Prerequisite for Layer 4. **Also unblocks a better Layer 3
   filter**: today `filterVoiceSamples` only checks each lead's LATEST 4 stored suggestions
   (`replies_json`), not full suggestion history — a suggestion log from B fixes that.
5. **Layer 1 — declared persona form** (#5). BLOCKED on the onboarding-capture decision (WhatsApp-native
   Q&A vs dashboard form) — user deferred ("decided later"). Only Layer 1 needs it; the nullable
   `agent_persona` columns from #3 make it pure data-entry when chosen.
6. **Layer 4 — evolution loop** (#6). Much later. Needs B's labeled corpus. autoresearch-style loop
   with a fast LLM-judge metric over ~20-40 saved convos + real response-rate as slow outer validator.
   Full research/rationale in personal-feat-brainstorm.md ("Research: karpathy/autoresearch").

### Model / prod
7. **Prod model swap** — before deploy, switch from local Ollama to OpenRouter + cloud model via env
   ([src/claude.ts:10](../src/claude.ts#L10)), no code change. Prod pick (from brainstorm doc): Gemini
   3.1 Flash-Lite primary, Claude Haiku 4.5 A/B challenger. Prompt-cache the fixed system+persona block.

---

## How to run

```
npm run repro        # replays the November screenshot conversation live (needs Supabase + Ollama up)
npm run simulate -- "your test message"   # single inbound through the brain
npx tsx scripts/voicesamples.test.ts      # offline filter self-check
npm run typecheck
```
