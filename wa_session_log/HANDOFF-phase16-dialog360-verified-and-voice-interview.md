# HANDOFF phase16 — dialog360 read-lane LIVE-VERIFIED + in-WhatsApp voice interview built

Date: 2026-07-27
Branch: `master` (main branch is `main`)
Status: **dialog360 read-lane VERIFIED LIVE on Mitko's real number. Voice interview (Layer 2C) BUILT + type-clean + logic-tested, NOT yet live — blocked on one DB migration.**

Continues from `HANDOFF-phase15b-baileys-live-verified.md`.

---

## TL;DR of this session

Picked up the last ⚠️ from phase15b: **verify the 360dialog read-lane** (Mitko's official
agent number). Did that — it works end-to-end. Along the way found + fixed two real bugs, then
built a new feature the user asked for: a **self-serve voice-capture interview that runs inside
WhatsApp** on the company number.

**The three headline outcomes:**
1. **dialog360 read-lane is VERIFIED LIVE** on Mitko's real number `971523398688`. Real lead
   message → webhook → brain → suggestion card. This was the one genuinely unproven lane.
2. **Fixed a stuck-pending-lead bug** (root cause): a failed approval-card send left the lead
   pending forever, never retried.
3. **Built the in-WhatsApp voice interview** (Layer 2C) — offered auto after first approval and
   via a typed `voice` command; runs 12 pre-scripted lead scenarios; extrapolates the voice card.

---

## What got done (in order)

1. **Confirmed the registry (read-only).** New `scripts/regcheck-readonly.ts` (no mutation, unlike
   the old `regcheck.ts`). Both rows resolve: `mitko`→`971523398688`, `you`→`971581871500`.
   `resolveAgentByReadNumber` matches on exact `digitsOnly(read_number)`.

2. **Flipped the pipe + booted dialog360 mode.** `.env` `AGENT_PIPE` `baileys`→`dialog360`
   (global XOR — Baileys off when this is on). The running baileys-mode server was killed
   (its `/agent-webhook` 404'd — only mounted in dialog360 mode). Rebooted; verify handshake
   `GET /agent-webhook?hub.challenge=…` returns 200. Tunnel live at
   `pogo-unharmed-stopping.ngrok-free.dev` (ngrok — **URL changes per run**).

3. **First live message → read-lane WORKS.** "Hello Mitko" from a lead phone hit the webhook,
   resolved to `mitko`, handed to brain. `[agent] in … → mitko: … — handing to brain`. ✅
   **This is the phase15b ⚠️ resolved.**

4. **BUG #1 — card send failed (24h window).** The approval card DM to Mitko failed with
   `status: failed` code 13xx. Root cause: Meta's **24-hour customer-service window** — the
   company number can't send free-form/interactive messages to a recipient who hasn't messaged
   it in 24h. Only pre-approved **templates** open a cold conversation. Mitko had never texted
   the company number. **Fix:** Mitko texted the company number `971581137568` once → window
   opened → all subsequent cards delivered (`sent`→`delivered`). This is normal onboarding.

5. **BUG #2 — stuck pending lead (real code bug, root-caused + fixed).** The first "Hello Mitko"
   (sent while the window was closed) created a `pending` lead row THEN fired `askApproval`
   fire-and-forget. The send failed, `.catch()` swallowed it, but the pending row persisted —
   and the monitor gate (`if lead.monitor !== "approved"` → drop) then dropped every future
   message. The lead was stuck: pending but un-approvable, card never retried.
   **Fix:** `src/brain.ts` now **awaits** `askApproval`; on failure it deletes the just-created
   row via new `deletePendingLead(agentId, phone)` in `src/store.ts` (guarded `monitor='pending'`
   so an approved/rejected lead's transcript is never removed). Next message re-fires fresh.
   Cleared the 3 stuck test leads with throwaway `scripts/clearpending.ts mitko`.

6. **RE-VERIFIED LIVE ✅** — after the window opened + the fix + a fresh message: the interactive
   approval button card delivered AND full suggestion replies were produced on Mitko's number.
   User confirmed: "amazing now its working produced the interactive button message and also
   suggested replys to the broker."

7. **Checked whether the voice interview was wired in.** It was NOT — only the
   `voice-extraction-role-play` SKILL existed (run manually by Claude). The consumption side
   (`getVoiceCard`→`suggestReplies`, distill loop) was fully wired, but Mitko's card was EMPTY
   (`card_upto=0`). So his replies were generic, not in his voice.

8. **BUILT the in-WhatsApp voice interview (Layer 2C).** User asked to implement it inside
   WhatsApp "to see the scope it works at." Design + files below.

---

## The voice interview — what was built

**Goal:** the agent onboards their own voice via WhatsApp, never leaving their chat. Bot plays
pre-scripted leads, agent replies as themselves, model extrapolates a voice card.

**Flow (both triggers, per user's choice):**
- **Auto** — right after the agent taps **Yes** on their first-ever lead approval, IF they have
  no voice card and no interview in flight, the bot sends a *"Want me to learn your voice?
  [Yes, let's do it] [Not now]"* interactive card. (Rides on the window the approval tap opened.)
- **Typed** — agent texts `voice` to the company number anytime.
- Then the bot walks **all 12** pre-scripted lead scenarios (ported from the SKILL), one at a
  time: *"Lead 1 of 12 — Abu, cash ready… reply as you would right now."* Captures each reply
  verbatim. **Zero LLM per turn** (scenarios are fixed text). After #12, ONE model call
  extrapolates the card → saves to `agent_persona.voice_card` with `card_upto = maxOutboundId`.
  Distill loop sharpens it thereafter.

**Design choices (user-picked):** all 12 required (no early-exit at 4); both triggers.

**Routing safety:** the interview gate sits BEFORE Q&A in the company.ts text branch, so the
agent's role-play answers aren't classified as "how many leads?" questions. Consent-button ids
(`voice:start`/`voice:skip`) are distinct from approval/stage ids, so the three taps never collide.

---

## Files changed / added THIS session

**New:**
- `src/voice-interview.ts` — 12 scenarios, state machine (`advance`, `handleInterviewText`,
  `offerInterview`, `interviewIntro`, `extractCard`), model extraction. Card format matches
  `distill.ts` CARD_FORMAT so seed + distill stay compatible.
- `supabase/migrations/008_add_interview_state.sql` — adds `agent_persona.interview_state jsonb`.
  **← THIS MUST BE APPLIED (see below).**
- `scripts/voiceinterview.test.ts` — state-machine self-check (pure, no DB/model). Wired into
  `npm run test:logic`.
- `scripts/regcheck-readonly.ts` — read-only registry check (no mutation).
- `scripts/clearpending.ts` — throwaway: clear stuck `pending` leads for an agent.

**Modified:**
- `src/brain.ts` — await `askApproval`, roll back pending row on failure (+ `deletePendingLead`
  import).
- `src/store.ts` — `deletePendingLead`; `getInterviewState`/`setInterviewState` + `InterviewState`
  type.
- `src/notify.ts` — `askVoiceConsent` (the offer card, interactive buttons).
- `src/company.ts` — `handleVoiceConsent` (button tap), `maybeOfferVoice` (auto-offer after
  approve), text-branch routing (interview → typed `voice` → stage → Q&A).
- `supabase/schema.sql` — `interview_state` column added to `agent_persona` (for fresh rebuilds).
- `package.json` — `voiceinterview.test.ts` added to `test:logic`.
- `.env` — `AGENT_PIPE=dialog360`.

Everything from phase15 (routing code) + phase15b is still UNCOMMITTED underneath this.

---

## ⚠️ BLOCKER to go live — apply ONE migration

The voice interview needs the DB column. Cannot be run from the dev box (no `psql`, no
`DATABASE_URL`, Supabase JS client can't run DDL, Supabase MCP needs interactive auth).

**Run in the Supabase SQL editor:**
```sql
alter table agent_persona add column if not exists interview_state jsonb;
```
Then restart the server (it's already `AGENT_PIPE=dialog360`) and test.

---

## Verification status now

| Lane / feature | Status |
|------|--------|
| Baileys read (`you`) → brain → card | ✅ verified (phase15b) |
| **dialog360 read (Mitko `971523398688` → brain → card)** | ✅ **VERIFIED LIVE this session** |
| Approval interactive card delivery to Mitko | ✅ verified (after window opened) |
| Full suggestion replies on Mitko's number | ✅ verified |
| Pending-lead rollback on failed prompt | ✅ code fixed, typecheck + re-verified live |
| Voice interview (Layer 2C) | ⚠️ built, type-clean, logic-tested — **NOT live until migration 008 applied** |
| Approval Yes/No tap → setMonitor | ✅ verified (the approve tap drove the flow) |
| Q&A ("how many leads?") → agent | ⚠️ not re-tested this session (Mitko's "Hi" hit the generic help fallback, which is correct — "Hi" isn't a question) |

---

## Leftover / next steps (priority order)

1. **Apply migration 008** (the one-line ALTER above) — unblocks the voice interview.
2. **Test the voice interview live** on Mitko: text `voice` to the company number (or approve a
   fresh lead to trigger the auto-offer), walk the 12 scenarios, confirm a card lands in
   `agent_persona` and subsequent replies sound like him. Watch the server log for
   `[voice-interview]` lines.
3. **Commit the pile.** STILL nothing committed — phase15 + phase15b + phase16 all sit
   uncommitted on `master` (not `main`). Remember the Co-Authored-By trailer. Suggested theme:
   "Phase 16: dialog360 read-lane verified + pending-lead rollback fix + in-WhatsApp voice
   interview (Layer 2C)."
4. **Strip the `[agent:diag]` / `[company:diag]` raw-body logs** in `src/pipe/dialog360.ts` and
   `src/company.ts` — the echo/payload shapes are confirmed now. Marked `ponytail:` for removal.
5. **Optional:** the per-turn soft "why did you phrase it that way?" nudge from the SKILL was
   deliberately skipped (adds an LLM call per turn). Add if cards come out thin.

---

## Gotchas carried forward

- **New agents must text the company number once** before the bot can DM them anything
  (24h-window rule — see the fix in step 4). Not a bug; it's onboarding.
- **ngrok URL changes every run** — Mitko's 360dialog webhook must point at the CURRENT tunnel
  `<tunnel>/agent-webhook`. If messages stop arriving, check the webhook URL first.
- **`AGENT_PIPE` is a global XOR** — dialog360 mode means Baileys is OFF. Can't read both dev +
  Mitko in one process yet (the ~10-line server.ts change from phase15b is still future work).
- **`scripts/regcheck.ts` MUTATES** the `you` row (kept from phase15b). Use the new
  `regcheck-readonly.ts` for a safe check.
- **A server may still be running on :3000** from this session (PID varies). Kill it before a
  fresh boot to avoid EADDRINUSE.
