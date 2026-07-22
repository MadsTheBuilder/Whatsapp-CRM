# Session Handoff — FourthspaceOS WhatsApp Assistant

**Date:** 2026-07-22
**Branch:** master
**Plan:** `~/.claude/plans/claude-dot-md-is-buzzing-kitten.md` (6 phases)
**This session completed:** Phase 4 (sender + Q&A) AND Phase 5 (daily reminders).
(Prior: Phase 0+1 `HANDOFF.md`, Phase 2+3 `HANDOFF-phase3.md`, Phase 4 detail `HANDOFF-phase4.md`.)
**Next:** Phase 6 — rebuild `server.ts` bootstrap, delete lead-send/web, repoint scripts.

---

## Done this session — Phase 5 (daily follow-up reminders, feature 3)

- **`src/reminders.ts`** (new):
  - **`runDailyReminders(): Promise<string | null>`** — `listLeads(AGENT_ID)`, read
    `responsiveness` per lead, pick the stale ones, DM the agent ONE digest via
    `notifyAgent`. Returns the digest sent, or `null` when nothing is stale (no send).
  - **Selection rule (`selectStale`, pure/exported):** a lead is stale iff its last
    message was **outbound** (`last_direction === "out"`) and it's been quiet **strictly
    > 3 days** (`silent_ms > STALE_MS`). That's "agent chased, lead ghosted" — the ball is
    in the agent's court. A lead whose last message was **inbound** (`"in"`, lead waiting on
    the agent) is deliberately OUT of scope — different, fresher signal, and `responsiveness`
    returns `silent_ms: null` there so there's no gap to measure. Sorted oldest-quiet first.
  - **Digest (`buildDigest`, pure/exported):** `"2 leads need a nudge:\n• Sara (Marina) —
    5 days quiet\n• Ahmed (JVC · buy · 2BR) — 4 days quiet"`. Name→phone fallback,
    `area · requirement` tag when present, singular/plural header. `ponytail:` one digest, not N.
  - **Tunables at top:** `STALE_MS = 3 days` (separate from and longer than the store's 24h
    `QUIET_MS`, which only marks the `no_reply` state), `REMINDER_INTERVAL_MS = 24h` (exported
    for the Phase-6 timer).
  - **`runDailyReminders` is NOT scheduled yet** — the timer belongs in the Phase-6
    `server.ts` bootstrap (`setInterval(runDailyReminders, REMINDER_INTERVAL_MS)` +
    a run on boot). Building the function + self-check now; wiring the timer in Phase 6.
  - Refactor note: selection + formatting were split into pure `selectStale`/`buildDigest`
    so the whole "which leads, what order, what text" path is testable without a live store;
    `runDailyReminders` is just the store-read wrapper around them.

## (Phase 4, same session — see HANDOFF-phase4.md for full detail)
- `src/notify.ts` → real 360dialog sender (`companySend` inlined, targets `AGENT_COMPANY_NUMBER`).
- `src/qa.ts` → `answerAgentQuestion(text)`: LLM intent → store answers (counts + lead summary).
- `src/company.ts` → `companyRouter` GET/POST `/company-webhook` (agent Q&A inbound).
- Decision: the webhook is a mountable `Router`, not a new `server.ts` (Phase 6 mounts it).

---

## Verification run this session (all green)

- `npx tsc --noEmit` → **clean**.
- **`npx tsx scripts/reminderlogic.test.ts`** (new) → **passed**. Covers: only >3-day
  outbound-last leads selected; the 3-day boundary is exclusive; oldest-quiet-first
  ordering; inbound-last and no-message leads excluded; digest tags/day-math/pluralization;
  name→phone fallback; empty → null.
- `npx tsx scripts/qalogic.test.ts` → passed. `npx tsx scripts/baileyparse.test.ts` → passed.
- **Read-only guarantee** unchanged: no `sock.sendMessage`; every send routes through
  `notifyAgent` → `AGENT_COMPANY_NUMBER`. The reminder digest goes to the agent, never a lead.

### NOT verified (needs live store/creds — manual pass later)
- `runDailyReminders()` end-to-end against live Supabase (seed a >3-day-old outbound lead,
  confirm one digest arrives at the agent's number, fresh/inbound leads excluded). The pure
  selection+digest path is unit-verified; the live store read + real 360dialog send are manual.

---

## Repo shape right now (read before Phase 6)

```
src/
  brain.ts        handleAgentMessage(ev)      — orchestration
  notify.ts       notifyAgent(body)           — real 360dialog sender
  qa.ts           answerAgentQuestion(text)   — LLM intent + store answers
  company.ts      companyRouter               — GET/POST /company-webhook
  reminders.ts    runDailyReminders()         — daily 3-day-silence digest   [NEW]
  store.ts        async Supabase store
  qualify.ts  replies.ts  memory.ts  claude.ts  listings.ts   — the brain (unchanged)
  pipe/{types.ts, baileys.ts}   types/qrcode-terminal.d.ts
scripts/
  storelogic.test.ts  baileyparse.test.ts  qalogic.test.ts  reminderlogic.test.ts [NEW]
supabase/schema.sql
```

- **`server.ts` still does NOT exist.** It's the Phase 6 deliverable.
- `wacrm/` — out of scope, ignore.

---

## NEXT — Phase 6 (rebuild server.ts bootstrap; delete lead-send/web; repoint scripts)

1. **New `src/server.ts` — a small bootstrap only:**
   - `import "dotenv/config"` (all env-gated modules assume it's loaded).
   - `startBaileys()` (from `src/pipe/baileys.ts`) — boot the read-pipe.
   - `app.use(companyRouter)` (from `src/company.ts`) — mount `/company-webhook`.
   - `runDailyReminders()` on boot + `setInterval(runDailyReminders, REMINDER_INTERVAL_MS)`
     (import both from `src/reminders.ts`). `ponytail:` in-process daily timer.
   - `app.listen(process.env.PORT ?? 3000)`.
   - **Do NOT** re-add `/api/send`, `/api/threads`, `/api/properties`, or static `web/` —
     those are the forbidden lead-send + inbox UI the plan deletes.
2. **Delete** `archive/src/web/` is already archived (nothing live to delete). Confirm no
   live `src/web/` exists (it doesn't).
3. **Repoint the brain self-check scripts** (still in `archive/scripts/`):
   `simulate.ts`/`memcheck.ts`/`respcheck.ts`/`stickycheck.ts` call the OLD sync
   `handleInbound` + sync store. Restore to `scripts/`, repoint at
   `handleAgentMessage(ev: AgentMessageEvent)` and `await` the now-async store. Update the
   stale `package.json` scripts (`dev`/`start`/`check`/`memcheck`/`respcheck`/`stickycheck`)
   which currently dangle at `src/server.ts` (soon real) and unrestored script paths.
4. Verify: `npm run typecheck`; run all four `scripts/*.test.ts`; then the repointed
   `check/memcheck/respcheck/stickycheck` against the live Supabase store.

That closes the plan (Phase 6 is the last).

---

## Gotchas for the next session

- **`notifyAgent` is live** — throws if `AGENT_COMPANY_NUMBER`/`DIALOG360_*` unset. A direct
  `runDailyReminders()` with a stale lead but no creds will throw at the send. The brain
  wraps its `notifyAgent` in `.catch`; `runDailyReminders` does not, so a real run needs creds.
- **`STALE_MS` (3d, reminders) ≠ `QUIET_MS` (24h, store).** Don't collapse them — the store's
  24h is the WhatsApp free-text window / `no_reply` flag; the 3d is the chase threshold.
- **Boot order in `server.ts`:** `import "dotenv/config"` must precede importing `store.ts`
  (it throws at import if `SUPABASE_*` unset) and any module that reads env at import.
- **`server.ts` doesn't exist** → `npm run dev`/`start` still do nothing until Phase 6.
  Working today: the four `scripts/*.test.ts` + `npm run typecheck`.
- Baileys warnings still apply (don't keep WhatsApp Web open on the same number; QR once).
