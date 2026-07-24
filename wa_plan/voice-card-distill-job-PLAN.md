# PLAN — Layer 2B: Auto-distill job for the voice card

Status: **PLAN, NOT YET EXECUTED.** Design only.
Continues [voice-roleplay-onboarding-PLAN.md](voice-roleplay-onboarding-PLAN.md) (Layer 2 seed) and
the Phase-12 handoff ([HANDOFF-phase12-voice-card-roleplay-layer2.md](../wa_session_log/HANDOFF-phase12-voice-card-roleplay-layer2.md)).

## Goal (plain words)

Turn the voice card from a one-time role-play seed into a **self-updating** card. Every time the
agent has hand-sent enough new messages, fold those real messages on top of the existing card so it
tracks how the agent actually writes over time. "Seed + living correction" — the seed is already
saved; this is the living-correction loop.

## What already exists (reuse, do NOT rebuild)

- **Table** `agent_persona (agent_id pk, voice_card, card_upto, updated_at)` — live in Supabase
  (migration `005` applied, seed card saved for `agent_demo`).
- **Read path** `getVoiceCard(agentId)` ([store.ts:354](../src/store.ts#L354)) → returns `""` when null.
- **Prompt wiring** `voiceCardBlock()` ([replies.ts:98](../src/replies.ts#L98)) — card already rides
  in every reply prompt.
- **The fold pattern to mirror** — `summarize()` ([memory.ts:34](../src/memory.ts#L34)): takes prior
  memory + ONLY new messages, returns updated memory. Never re-reads the old transcript. The distill
  job is the SAME shape for the card.
- **The write pattern to mirror** — `saveMemory()` ([store.ts:376](../src/store.ts#L376)): updates
  the row + advances the `summary_upto` watermark in one call.
- **The watermark pattern to mirror** — `lead.summary_upto` + `messages.filter(m => m.id > upto)`
  ([brain.ts:100-103](../src/brain.ts#L100-L103)). `card_upto` is the identical idea, agent-wide.
- **The self-imitation filter** — `filterVoiceSamples(bodies, suggested, limit)`
  ([store.ts:302](../src/store.ts#L302)) + the suggestion-gathering in `recentAgentSamples()`
  ([store.ts:316-349](../src/store.ts#L316-L349)). Drops outbound messages that are verbatim copies
  of our own suggestions. **The distill job MUST run through this** or the card learns the AI's voice
  back and drifts generic.

## Decisions locked (from this session)

- **Scope: agent-wide, TOTAL across all leads.** The card is one row per agent (no `lead_id`). Voice
  doesn't change by recipient. `card_upto` is a single global watermark over the agent's entire
  outbound stream. Threshold counts total hand-sent messages, never per-lead.
- **Trigger: threshold-on-send.** After an outbound message is stored, check
  `(max outbound id) − card_upto ≥ N`; if so, distill. Hooked at the existing `direction === "out"`
  early-return in the brain ([brain.ts:82-85](../src/brain.ts#L82-L85)) — the message is already
  saved there, no suggestion is generated, clean seam. Fire-and-forget so it never blocks or fails
  the read-pipe.
- **N = 20** (tunable constant). 20 new hand-sent messages, any mix of leads.
- **Card format unchanged** — same tight-markdown blob the seed uses; distill folds text-into-text
  exactly like `summarize()` folds summary-into-summary.

## Design

### A. New watermark-aware sample reader — `store.ts`

`recentAgentSamples()` returns only `body` (no id) and caps at 15 — wrong for distill, which needs
message **ids** (to advance the watermark) and **all** unseen outbound messages since `card_upto`.
Add a sibling that shares the same self-imitation filter:

```typescript
// Outbound messages the agent hand-sent since `sinceId`, with their ids, minus
// verbatim copies of our own suggestions (same filter recentAgentSamples uses).
// Returns [] when nothing new. Ordered oldest→newest so the fold reads in sequence.
export async function unfoldedAgentSamples(
  agentId: string,
  sinceId: number,
): Promise<{ id: number; body: string }[]>
```

Implementation: same two queries as `recentAgentSamples` but `.gt("id", sinceId)`, ascending, no
limit; build the same `suggested` Set from the leads' `replies_json`; keep rows whose trimmed body
isn't in `suggested`. Return `{id, body}` pairs.

> ponytail: `recentAgentSamples` and this share ~20 lines (the suggestion-gathering). Extract a
> private `suggestedRepliesFor(agentId, leadIds)` helper both call — smaller than duplicating the
> replies_json parse. Do this only if it stays a clean lift; if it fights the existing shape, leave
> `recentAgentSamples` alone and duplicate the ~6-line Set build.

### B. The distill function — `distill.ts` (new file, mirrors `memory.ts`)

Pure-ish LLM fold, structurally identical to `summarize()`:

```typescript
export async function distillVoiceCard(
  priorCard: string,           // "" on first distill (but seed exists, so usually non-empty)
  newSamples: string[],        // the agent's real hand-sent messages since card_upto
): Promise<string>             // the updated card (same markdown format)
```

- SYSTEM prompt: "You maintain a voice card describing how THIS agent writes on WhatsApp. You're
  given the card SO FAR and only NEW real messages the agent sent since it was last updated. Fold
  the new messages in: sharpen traits the new messages confirm, correct traits they contradict, add
  a newly-visible habit, drop nothing still true. Keep the exact section format. Keep it tight — it
  rides in every reply prompt. Update the `Real examples:` block to the strongest 3-4 verbatim
  messages (prefer newer). If there's no prior card, build one from the messages alone."
- Reuse the SAME card format from the role-play skill (the 8 VOICE lines + Real examples + Never).
  Put the format literally in the prompt so the model preserves it.
- Structured output: `{ voice_card: string }` (one field — the whole blob is text, no per-field
  JSON, matching plan-B's "text not JSON" decision).

> ponytail: one string in, one string out, one LLM call. No `VoiceCard` interface, no field parsing.

### C. The write path — `saveVoiceCard()` in `store.ts` (mirrors `saveMemory`)

```typescript
// Overwrite the agent's card and advance the watermark to the newest folded id.
export async function saveVoiceCard(
  agentId: string,
  card: string,
  upto: number,
): Promise<void> {
  const { error } = await db.from("agent_persona").upsert(
    { agent_id: agentId, voice_card: card, card_upto: upto, updated_at: new Date().toISOString() },
    { onConflict: "agent_id" },
  );
  if (error) throw error;
}
```

Upsert (not update) so it also works if the row was never seeded. This is the write path the
Phase-12 handoff flagged as missing.

### D. The orchestrator — `maybeDistillVoiceCard()` in `distill.ts`

Ties A→B→C together behind the threshold. This is what the trigger calls.

```typescript
export const DISTILL_THRESHOLD = 20; // new hand-sent msgs since last distill

// Read watermark → count unseen → if < threshold, no-op → else fold + save.
// Returns true if a distill ran (for logs/tests), false if skipped.
export async function maybeDistillVoiceCard(agentId: string): Promise<boolean>
```

Steps:
1. Read `card_upto` (+ current `voice_card`) for the agent. New store getter
   `getVoiceCardState(agentId): Promise<{ card: string; upto: number }>` — one row read; `getVoiceCard`
   stays as-is for the reply path.
2. `const samples = await unfoldedAgentSamples(agentId, upto)`.
3. If `samples.length < DISTILL_THRESHOLD` → return false (no LLM call).
4. `const updated = await distillVoiceCard(card, samples.map(s => s.body))`.
5. `await saveVoiceCard(agentId, updated, samples[samples.length - 1].id)`.
6. Return true.

**Concurrency guard (ponytail):** a per-agent in-memory `Set<string>` of "distill in flight". The
threshold-on-send trigger can fire twice before the first save advances the watermark; the guard
drops the second. `// ponytail: in-memory lock, fine for one process/one agent; move to a DB
advisory lock if multi-instance.` Skip if we decide the double-fold is harmless — but a wasted LLM
call isn't free, so keep the guard.

### E. The trigger — `brain.ts`

At the existing outbound early-return ([brain.ts:82-85](../src/brain.ts#L82-L85)):

```typescript
if (ev.direction === "out") {
  // Threshold-driven voice-card refresh from the agent's real messages. Fire-and-
  // forget: a failed/slow distill must never touch the read-pipe. Guarded + gated
  // by DISTILL_THRESHOLD inside, so most calls are a cheap watermark read + count.
  maybeDistillVoiceCard(ev.agentId).catch((e) => console.error("distill failed:", e));
  return lead.id;
}
```

One import, one fire-and-forget line. No await (never block the pipe), no throw path into the loop.

## Cold-start / degradation

- Seed exists → first distill folds new messages onto it. If somehow no card, `distillVoiceCard`
  builds from messages alone (same as `summarize` with empty prior).
- < 20 new messages → no LLM call, no write, today's behavior. Monotonic: a distill only ever
  replaces the card with a card built from MORE of the agent's real voice.
- Distill throws → caught, logged, card unchanged, watermark not advanced → retried next outbound.
  Zero regression to the reply path (it just reads whatever card is there).

## Files touched

| File | Change |
|------|--------|
| `src/store.ts` | `unfoldedAgentSamples()`, `saveVoiceCard()`, `getVoiceCardState()` (+ optional `suggestedRepliesFor` helper) |
| `src/distill.ts` | NEW — `distillVoiceCard()`, `maybeDistillVoiceCard()`, `DISTILL_THRESHOLD`, concurrency guard |
| `src/brain.ts` | one import + one fire-and-forget line at the `out` early-return |

No schema change — `agent_persona.card_upto` already exists (default 0).

## Verification

1. **Watermark math (pure, offline)** — `scripts/distill.test.ts`: assert the count-since-watermark
   gate. Seed `card_upto`, feed a list of `{id, body}`, assert distill fires only at ≥ threshold and
   the new `upto` = last folded id. Same offline style as `qualgate.test.ts` (dummy Supabase creds).
2. **Self-imitation filter reused** — assert `unfoldedAgentSamples` drops a body that equals a stored
   suggestion (reuse a `filterVoiceSamples`-style fixture). Proves the card can't learn the AI back.
3. **Fold changes the card (live, manual)** — a throwaway script: set `card_upto` low, insert ~20
   fake outbound messages in a distinctive voice, run `maybeDistillVoiceCard("agent_demo")`, read the
   row back, confirm the card shifted toward the injected voice AND `card_upto` advanced. (Live
   Supabase + model key, like `simulate`.) Delete the script after.
4. `npx tsc --noEmit` clean; `npm run test:logic` still green (new test added to the chain).

## Implementation order

1. `saveVoiceCard()` + `getVoiceCardState()` in store.ts (write path first — smallest, unblocks manual saves too).
2. `unfoldedAgentSamples()` in store.ts (+ optional shared helper).
3. `src/distill.ts` — `distillVoiceCard()`, then `maybeDistillVoiceCard()` + guard + threshold.
4. Wire the trigger into brain.ts.
5. `scripts/distill.test.ts` (checks 1-2) + add to `test:logic`.
6. Live fold check (3), then tsc + tests (4).

## Explicitly NOT now (defer)

- **Cron/scheduled distill** — threshold-on-send covers it; revisit only if we want a time-based
  refresh for low-volume agents.
- **Multi-instance locking** — in-memory guard is fine for the one-process/one-agent setup.
- **Hand-editing / rolling back the card** — write-only from seed + distill (avoids bad input to the
  next fold), same call the seed decision made.
- **Distilling INBOUND (lead) messages** — the card is the AGENT's voice only; only `direction:"out"`
  feeds it.
- **Workstream B (response-rate labeling), Layer 4 (evolution loop)** — separate builds.
