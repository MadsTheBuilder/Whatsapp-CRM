# Session Handoff — FourthspaceOS WhatsApp Assistant (Phases 4–5)

**Date:** 2026-07-22
**Branch:** master (uncommitted — nothing committed this session)
**Plan:** `~/.claude/plans/claude-dot-md-is-buzzing-kitten.md` (6 phases)
**Source of truth:** `CLAUDE.md` (overrides all older plans/docs)
**This session completed:** Phase 4 + Phase 5.
**Next:** Phase 6 (the final phase).

---

## What this product is (one paragraph)

Read-only WhatsApp assistant for one Dubai real-estate agent. A bot on a **company
number** (360dialog) quietly watches the agent's chats with leads and privately DMs the
agent four things: suggested replies, lead summaries, daily 3-day-silence reminders, and
answers to on-demand questions. **The bot never messages a lead.** The agent's own number
is read via a **swappable pipe** (Baileys now, 360dialog later) feeding one normalized
`AgentMessageEvent` into the brain. Storage is **Supabase** (no local DB).

---

## What this session did (summary — full detail in the per-phase handoffs)

- **Phase 4** — real 360dialog sender + agent Q&A inbound. Detail:
  [`wa_session_log/HANDOFF-phase4.md`](HANDOFF-phase4.md).
  - `src/notify.ts` — `notifyAgent(body)` now really sends via 360dialog (`companySend`
    inlined; BSP selector collapsed). Targets `AGENT_COMPANY_NUMBER`, never a lead.
  - `src/qa.ts` — `answerAgentQuestion(text)`: LLM classifies intent
    (`count_leads | count_qualified | count_no_reply | summarize_lead | unknown`) → answers
    from the store. Exports pure `isQualified` / `findLead`.
  - `src/company.ts` — `companyRouter`: `GET/POST /company-webhook` (verify handshake +
    agent-only text → `answerAgentQuestion` → `notifyAgent`). It's a mountable Router, NOT a
    new `server.ts` (deliberate — Phase 6 mounts it, so `server.ts` isn't built twice).
- **Phase 5** — daily follow-up reminders. Detail:
  [`wa_session_log/HANDOFF-phase5.md`](HANDOFF-phase5.md).
  - `src/reminders.ts` — `runDailyReminders()`: selects leads the agent chased that went
    quiet **>3 days** (last direction `out`, `silent_ms > STALE_MS`), DMs one digest.
    Pure `selectStale` / `buildDigest` split out for offline testing. `STALE_MS = 3d`,
    `REMINDER_INTERVAL_MS = 24h` (exported for the Phase-6 timer). Timer NOT wired yet.

The prior session's Phase 2+3 detail (pipe seam, `brain.ts`, Baileys read-pipe) is in
[`wa_session_log/HANDOFF-phase3.md`](HANDOFF-phase3.md); Phase 0+1 in `HANDOFF.md`.

---

## Verification state (all green this session — no live network)

- `npx tsc --noEmit` → clean.
- Four offline self-checks pass: `scripts/storelogic.test.ts`, `baileyparse.test.ts`,
  `qalogic.test.ts` (Phase 4), `reminderlogic.test.ts` (Phase 5).
- Read-only guarantee holds: no `sock.sendMessage`; every send routes through `notifyAgent`
  → `AGENT_COMPANY_NUMBER`.
- **NOT verified (needs live Supabase / 360dialog creds — manual pass):** real 360dialog
  send, company-webhook HTTP round-trip, `runDailyReminders()` against a live store, LLM
  intent accuracy. Listed per-phase in the two handoff docs above.

---

## Repo shape (current)

```
src/  brain.ts notify.ts qa.ts company.ts reminders.ts store.ts
      qualify.ts replies.ts memory.ts claude.ts listings.ts
      pipe/{types.ts, baileys.ts}  types/qrcode-terminal.d.ts
scripts/  storelogic.test.ts baileyparse.test.ts qalogic.test.ts reminderlogic.test.ts
supabase/schema.sql
```
- **`src/` is entirely untracked in git** (the new build); the old `src/` → `archive/`
  move is staged. Nothing is committed this session.
- **`src/server.ts` does NOT exist** — it's the Phase 6 deliverable. `npm run dev`/`start`
  do nothing yet. Only the four `scripts/*.test.ts` + `npm run typecheck` run today.
- `wacrm/` (Next.js CRM) — out of scope, ignore.

---

## NEXT — Phase 6 (final): rebuild server.ts, delete lead-send/web, repoint scripts

Full step list in [`wa_session_log/HANDOFF-phase5.md`](HANDOFF-phase5.md) → "NEXT — Phase 6".
In brief:
1. **New `src/server.ts`** — thin bootstrap: `import "dotenv/config"` FIRST (before `store.ts`,
   which throws at import if `SUPABASE_*` unset), then `startBaileys()`, `app.use(companyRouter)`,
   `runDailyReminders()` on boot + `setInterval(runDailyReminders, REMINDER_INTERVAL_MS)`,
   `app.listen(PORT)`. Do NOT re-add `/api/send`, `/api/threads`, `/api/properties`, or `web/`
   (forbidden lead-send + inbox UI).
2. **Repoint the brain self-checks** still in `archive/scripts/`
   (`simulate/memcheck/respcheck/stickycheck`): they call the OLD sync `handleInbound` + sync
   store — restore to `scripts/`, repoint at `handleAgentMessage(ev: AgentMessageEvent)` and
   `await` the async store. Fix the stale `package.json` scripts pointing at them + `server.ts`.
3. Verify: `npm run typecheck`; all `scripts/*.test.ts`; then repointed checks against live Supabase.

---

## Gotchas (carry-forward)

- **`notifyAgent` is live** — throws if `AGENT_COMPANY_NUMBER`/`DIALOG360_*` unset. `brain.ts`
  wraps it in `.catch`; `runDailyReminders` does not — a real reminder run needs creds.
- **`STALE_MS` (3d, reminders) ≠ `QUIET_MS` (24h, store)** — don't collapse them.
- **Company-webhook gate:** with `AGENT_COMPANY_NUMBER` unset it answers ANY inbound text —
  set it in real deployments so only the agent's questions are handled.
- **supabase-js is lazy** — offline tests use dummy `SUPABASE_*` creds and only call pure
  helpers, so no connection opens.
- Baileys: don't keep WhatsApp Web open on the same number; QR scanned once via persisted auth.
- No secrets are stored in the repo; `.env.example` documents the required var names only.

---

## Suggested skills for the next session

- **`verify`** — before committing Phase 6, drive the actual flow (boot `server.ts`, hit the
  webhook, trigger a reminder) rather than trusting typecheck + unit tests alone.
- **`code-review`** (or `/simplify`) — review the Phase 4–6 diff for correctness and any
  reuse/simplification cleanups once Phase 6 lands.
- **`ponytail-audit`** — the plan is nearly done; a whole-repo over-engineering pass would
  catch any leftover scaffolding (`archive/` cleanup, unused `bsp/` remnants) before wrap-up.
