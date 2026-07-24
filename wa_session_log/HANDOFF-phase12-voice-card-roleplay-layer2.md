# HANDOFF — Phase 12: Voice-card role-play (Layer 2, partial)

Date: 2026-07-24
Branch: master
Status: **Onboarding role-play run. Card drafted, NOT yet saved to Supabase. No code written this session.**

## Context

Continues `personal-feat-brainstorm.md`'s ADJUSTED BUILD ORDER. That doc's step 3 ("Layer 2 —
voice card + distill job") was already half-built going into this session: `agent_persona` table,
`getVoiceCard()` read path, and `voiceCardBlock()` prompt wiring all existed. What was missing was
any way to actually populate `voice_card` with real signal. This session used the
`.claude/skills/voice-extraction-role-play/SKILL.md` skill (already present in the repo, not
authored this session) to manually seed a first card via role-play.

## What happened this session

1. Ran the full 12-scenario role-play (`voice-extraction-role-play` skill) — played 12 different
   lead personas (ready buyer, low-intent browser, frustrated client, re-engagement, price
   pushback, competitor comparison, post-viewing ghost, skeptic, kickback ask, overseas investor,
   over-eager lead, terse texter). Agent replied in-character to each, unedited, as themselves.
   502 words of real reply material captured across all 12.
2. Drafted a voice card from those 12 replies (length/rhythm, vocabulary, emoji/punctuation,
   greeting/sign-off, warmth vs pressure, objection moves, money/ethics, signature quirks, 4
   verbatim examples, "never" rules).
3. User asked to compare against a **prior, shorter voice-card session** (pasted from elsewhere —
   not logged anywhere in this repo, no file backs it). Compared the two side by side:
   - Strong agreement on: no emoji/exclamation marks ever, brief warmth immediately paired with a
     firm boundary, reframes objections onto factual/market reality, dry self-aware humor in
     follow-ups (the "even if it's as simple as you didn't like my tie" line was **verbatim
     identical** across both independent sessions — strong signal), typos left unedited.
   - Old card's "time-aware greeting (good evening)" claim looked over-fit to a single example
     (Abu) and wasn't corroborated by the 12-scenario data — flagged as likely noise.
   - New 12-scenario card picked as the winner (not merged, per explicit user correction): more
     data (12 replies vs. the older, smaller set), and covers dimensions the old session never
     reached (money/ethics, competitor pushback, skepticism, overseas process, over-eager pacing,
     terse-texter energy matching).
4. **Did NOT save the card to Supabase.** The skill's storage step (upsert into `agent_persona`,
   keyed on `agent_id` from `.env`) was never executed — the conversation moved to comparison and
   analysis instead of confirming and saving.

## What is left — Layer 2 full picture

### A. Immediate — finish this session's thread
- [ ] **Save the winning (12-scenario) voice card** to `agent_persona.voice_card` via the upsert in
  the skill's Storage section. `AGENT_ID` is already set in `.env`. This is a single SQL upsert,
  no code change — just needs to actually be run.

### B. The real gap — auto-distill job (see prior session's Layer-2 breakdown)
Storage + prompt-consumption already work (`agent_persona` table, `getVoiceCard()`,
`voiceCardBlock()` in [replies.ts:98](../src/replies.ts#L98)). What's missing is turning this from
a one-time manual role-play into an ongoing auto-learning loop:

1. **Distill function** — read an agent's real `direction:"out"` messages from `messages`, fold
   them into an updated `voice_card`. Mirror the existing `summarize()` fold-in pattern
   ([brain.ts:95-106](../src/brain.ts#L95-L106)).
2. **Save path** — no `saveVoiceCard()` exists yet; `getVoiceCard()` is read-only. Needs a write
   function analogous to `saveMemory()` ([store.ts:376](../src/store.ts#L376)).
3. **Watermark logic** — `card_upto` column exists on `agent_persona` but nothing reads or
   advances it. Needs the same "since last watermark" query pattern `summary_upto` already uses.
4. **Trigger** — nothing calls the distill job. Needs a threshold check (N new sent messages since
   last distill) and/or a hook into the existing daily reminder cron.
5. **Reuse the self-imitation filter** — `filterVoiceSamples()` ([store.ts:302](../src/store.ts#L302))
   already excludes messages that are verbatim copies of our own suggestions, built for Layer 3.
   The distill job must reuse it, or the card ends up learning the AI's own voice back.

### C. Not started (unchanged from prior handoff)
- Workstream B — response-rate labeling (got-reply / no-reply per suggestion). No code anywhere.
- Layer 1 — declared persona onboarding form. Deferred by user decision, method still unchosen
  (WhatsApp-native Q&A vs. dashboard form vs. auto-seed).
- Layer 4 — evolution loop. Explicitly deferred until B has a labeled corpus.

## Files touched this session
None. Pure conversation — role-play transcript lives only in this chat, captured above and in the
drafted card. No commits, no schema changes, no code edits.

## Next session should start with
Confirm the card in section A is still what we want, save it, then move straight to B.1 (the
distill function) — that's the actual unfinished core of Layer 2.
