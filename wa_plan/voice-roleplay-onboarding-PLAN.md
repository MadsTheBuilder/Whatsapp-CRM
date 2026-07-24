# PLAN (next session) — Voice-extraction via role-play onboarding skill

Status: **APPROVED PLAN, NOT YET EXECUTED.** Design only — no code written this session.
Supersedes the input method in [voice-skill-agent-onboarding.md](voice-skill-agent-onboarding.md)
(the paste-30-100-messages approach). This is Layer 2 of the personalized-reply system
(see [personal-feat-brainstorm.md](personal-feat-brainstorm.md)).

## Context

`suggestReplies()` in [src/replies.ts](../src/replies.ts) sounds generic/AI — the model never
sees THIS agent's real voice. Fix: a per-agent **voice card** (Layer 2) prepended to the reply
prompt.

First onboarding draft asked the agent to paste 30–100 of their own sent messages into a Claude
"Voice Skill" (adapted from the Nerdy Novelist gist). **Rejected:** brand-new agents have no
exported history, real message dumps are mostly dull logistics, and pasting is friction.

**New direction:** the onboarding skill **role-plays** — Claude plays a series of leads across
deliberately chosen scenarios (ready lead, time-waster, angry, re-engagement); the agent replies
naturally as themselves; their true voice is **extrapolated** from how they handle each. Output =
a voice card that seeds `agent_persona.voice_card`; a later distill job corrects it from real sent
messages ("seed + living correction").

## Decisions locked
- **Role-play mode:** agent replies AS THEMSELVES to Claude-played leads (not editing drafts, not
  an interview). Truest voice signal.
- **Venue:** DEFERRED — skill is venue-agnostic (agent's own Claude vs WhatsApp-native vs dashboard
  decided later). All three consume the same card.
- **Card lifecycle:** role-play card = SEED; later distill job folds real sent msgs on top. Distill
  job is a LATER build, NOT this plan.
- **Card format:** tight markdown TEXT, not JSON (see B).

## Findings (exploration — reuse these, do NOT invent parallel paths)

The reply prompt ALREADY consumes an agent's voice — the missing piece is a persisted seed:

- Reply assembly: [src/brain.ts](../src/brain.ts):112-127 calls
  `suggestReplies(recent, stage, memory, q, listings, samples)`.
- `samples` = `recentAgentSamples(agentId, 15)` ([src/store.ts](../src/store.ts):316-350) —
  agent-wide recent OUTBOUND msgs, filtered by `filterVoiceSamples()` (store.ts:302-314) to drop
  verbatim copies of our own suggestions. **Returns EMPTY for a new agent → generic fallback.**
  This is the gap the seed fills.
- `samplesBlock()` (replies.ts:89-93) already injects samples; SYSTEM prompt (replies.ts:8-35)
  already says "mirror their voice — sentence length, greetings, sign-offs, emoji habits". A card
  rides the SAME injection path — no SYSTEM change needed.
- `groundingBlock()` (replies.ts:72-84) handles ANSWERED/UNKNOWN facts — unrelated, leave alone.
- NO `agent_persona` table / `voice_card` column yet. `leads` uses a `summary` + `summary_upto`
  watermark the future distill job should mirror.
- No onboarding form/endpoint. Dashboard ([mockups/control-center.html](../mockups/control-center.html),
  [src/api.ts](../src/api.ts)) is READ-ONLY. Agent identity = single `AGENT_ID` env var
  ([src/company.ts](../src/company.ts):13) — one agent today.
- [.claude/skills/reply-persona/SKILL.md](../.claude/skills/reply-persona/SKILL.md) is a POLICY doc
  (not interactive) — reference for frontmatter/DO-DONT style, not a role-play template.

## Design

### A. The skill: `.claude/skills/voice-extraction-role-play/SKILL.md`

Interactive Claude skill (not product code). Claude plays 4 leads in order; agent types their REAL
reply each time; skill extrapolates a voice card. Venue-agnostic.

**4 scenarios** (each isolates a voice dimension real chats muddy together):
1. **Ready buyer** — cash-ready, wants a viewing this week → warmth, confidence, brevity, how they
   push to a viewing.
2. **Low-intent browser** — "just curious 😊", no budget → patience, gentle qualification,
   casual-tone emoji, boundary-setting without pushiness.
3. **Angry lead** — "5 viewings, none matched — refund or I leave" → composure, own-the-mistake vs
   defensive, de-escalation phrasing.
4. **Re-engagement** — agent INITIATES to a 2-week-silent lead → follow-up opener, personalization,
   soft re-engagement vs hard chase, sign-off.

**Session flow:** intro → per scenario present lead context + message, agent replies freely (no
editing Claude's words, no drafts), optional soft "why'd you phrase it that way?" → after 4,
produce card, show it, confirm, save. **Anti-leading:** never coach, never show a "good" reply to
compare against, no scoring — pure capture.

Scenario copy for the skill is drafted below in Appendix.

### B. Card format — TIGHT MARKDOWN TEXT (not JSON)

The reply prompt is a *text* prompt; the model reads prose, not JSON. A JSON card would force a
`VoiceCard` interface + parse/validate + cherry-picking fields at inference. Instead the card is
**one short markdown blob** — same as the existing `leads.summary` (plain `text`). Distill job
later folds text-into-text exactly like `summarize()` folds into `summary`. Keep it tight — it
rides in EVERY reply prompt (KV/context cost):

```
VOICE (from onboarding):
- length/rhythm: <1 line>
- vocabulary & language mix: <1 line>
- emoji & punctuation: <1 line>
- greeting/sign-off: <1 line>
- warmth vs pressure: <1 line>
- objection/sales moves: <1 line>
- signature quirks: <1 line>
Real examples: <2-3 of the agent's own role-play replies, verbatim>
Never: <2-3 negative-space rules>
```

### C. Storage + wiring — smallest diff, rides the existing injection path (~30 LOC)

1. **[supabase/schema.sql](../supabase/schema.sql)** + migration `005_add_agent_persona.sql`:
   ```sql
   create table agent_persona (
     agent_id   text primary key,
     voice_card text,                         -- markdown blob; null = generic fallback
     card_upto  bigint not null default 0,    -- watermark for the FUTURE distill job (unused now)
     updated_at timestamptz not null default now()
   );
   ```
   `card_upto` included now (unused) so the distill job is data-entry, not a migration — mirrors
   `leads.summary_upto`.

2. **[src/store.ts](../src/store.ts)** — one function, returns a string (no interface):
   ```typescript
   export async function getVoiceCard(agentId: string): Promise<string> {
     const { data } = await db.from("agent_persona")
       .select("voice_card").eq("agent_id", agentId).maybeSingle();
     return (data?.voice_card as string | null) ?? "";
   }
   ```

3. **[src/replies.ts](../src/replies.ts)** — block fn mirroring `samplesBlock()` (89-93); new
   `card` param on `suggestReplies()` (104-111); prepend the block in prompt assembly (115). No
   SYSTEM change.
   ```typescript
   function voiceCardBlock(card: string): string {
     return card.trim() ? `\n${card.trim()}\n` : "";
   }
   ```
   Assembly (115) becomes:
   `${memory}Relationship stage: ${stage}\n${groundingBlock(qualification)}\n${voiceCardBlock(card)}${samplesBlock(samples)}${listingsBlock(listings)}\nConversation so far:\n${convo}`

4. **[src/brain.ts](../src/brain.ts)** — fetch alongside samples (126) and pass through (127):
   ```typescript
   const card = await getVoiceCard(ev.agentId);
   const samples = await recentAgentSamples(ev.agentId);
   const replies = await suggestReplies(recent, stage, memory, q, listings, card, samples);
   ```

Card prepends BEFORE live samples: card = distilled intent, samples = live grounding. Both fire.

### D. Cold-start / degradation
No card → `getVoiceCard()` returns `""` → `voiceCardBlock()` no-ops → today's behavior, zero
regression. Existing agents with samples but no card keep working; running the skill only adds
signal (card + samples > samples alone). Monotonic.

### E. Explicitly NOT now (defer)
- **Distill job** (seed→living-correction) — later build; `card_upto` watermark already placed.
- **Dashboard paste/onboarding UI** — dashboard read-only; skill runs in Claude.
- **WhatsApp-native venue** — venue deferred; skill is venue-agnostic.
- **Hand-editing the card** — write-only from skill (+ future distill); avoids bad distill input.
- **`REPLY_MODEL`/OpenRouter swap** — orthogonal; card is model-agnostic.

## Verification
1. **Card produced** — run the skill, answer the 4 scenarios, confirm a saved row:
   `select voice_card from agent_persona where agent_id = <id>` is non-empty markdown with examples.
2. **Card reaches the prompt** — extend [scripts/simulate.ts](../scripts/simulate.ts) (or
   [scripts/repro-november.ts](../scripts/repro-november.ts)) to log the assembled prompt; confirm
   the `VOICE (from onboarding):` block appears.
3. **Card changes output** — generate replies for one lead message with the card vs with `card=""`,
   side by side. With-card should visibly match the role-play voice (length, emoji, greeting) vs the
   generic baseline. `npx tsc --noEmit` clean; existing tests still pass.

## Implementation order (next session)
1. Schema + migration `005_add_agent_persona.sql` (apply to live Supabase).
2. `getVoiceCard()` in store.ts.
3. `voiceCardBlock()` + `card` param + assembly in replies.ts.
4. Fetch + pass-through in brain.ts.
5. Write `.claude/skills/voice-extraction-role-play/SKILL.md` (use Appendix scenario copy).
6. Verify (3 checks above).

---

## Appendix — scenario copy for SKILL.md

```markdown
## Scenario 1 — The Ready Buyer
Lead: Abu, 45, engineer, bought in Dubai before, cash ready, moving fast.
His message:
> Hi, I've got cash ready and want to close on a 2BR in Jumeirah within a month.
> What's available in the 3-4M range? Can we do a viewing this week?
Your turn: reply to Abu as you would on WhatsApp right now. Just your real response.

## Scenario 2 — The Low-Intent Browser
Lead: Sarah, 28, curious, no budget or timeline.
Her message:
> Hey! Just browsing for fun 😊 what kind of apartments do you have?
> Nothing specific, just curious what's out there.
Your turn: reply to Sarah as you would on WhatsApp right now.

## Scenario 3 — The Frustrated Client
Lead: Hassan, 50, upset — last 5 viewings didn't match what he asked for, considering leaving.
His message:
> This is ridiculous. You showed me 5 places and none were close to what I said.
> I want a refund of the viewing fees or I'm going to another agent.
Your turn: reply to Hassan as you would on WhatsApp right now.

## Scenario 4 — The Re-Engagement
Lead: Fatima, 35, was interested in JVC, silent for 2 weeks. YOU initiate.
Your turn: write a follow-up to Fatima — she hasn't messaged; you're checking in. What do you send?
```
