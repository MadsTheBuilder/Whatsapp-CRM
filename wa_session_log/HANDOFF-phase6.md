# Session Handoff — FourthspaceOS WhatsApp Assistant (Phase 6 — FINAL)

**Date:** 2026-07-22
**Branch:** master (uncommitted — nothing committed this session)
**Plan:** `~/.claude/plans/claude-dot-md-is-buzzing-kitten.md` (6 phases) — **now complete.**
**Source of truth:** `CLAUDE.md`
**This session completed:** Phase 6. The plan is closed.

---

## What Phase 6 did

1. **New `src/server.ts`** — thin bootstrap, nothing else:
   - `import "dotenv/config"` FIRST (store.ts throws at import if `SUPABASE_*` unset).
   - `express()` + `express.json()` + `app.use(companyRouter)` → mounts `/company-webhook`.
   - `startBaileys()` — read-pipe on the agent's number; a boot failure is fatal (`process.exit(1)`).
   - `runDailyReminders()` on boot + `setInterval(..., REMINDER_INTERVAL_MS)`; the tick is
     `.catch`-wrapped so a transient store/360dialog error logs but never kills the process.
   - `app.listen(PORT)`.
   - **Deliberately NOT added:** `/api/send`, `/api/threads`, `/api/properties`, static `web/` —
     the forbidden lead-send + inbox UI. The bot never sends to a lead.

2. **Repointed the four brain self-checks** from `archive/scripts/` → `scripts/`. They used a
   dead API — `handleInbound(phone,text,name)` from the deleted `webhook.ts`, sync `getLead`,
   and (respcheck/stickycheck) raw `node:sqlite` against the banned `fourthspace.db`:
   - `simulate.ts` / `memcheck.ts` → call `handleAgentMessage(AgentMessageEvent)` and `await`
     the async store. (Live Supabase + model key.)
   - `respcheck.ts` / `stickycheck.ts` → rewritten to drive the async Supabase store via
     `@supabase/supabase-js` (seed rows, assert, clean up) — no SQLite, no `fourthspace.db`.
     (Live Supabase.)

3. **`package.json`** — added `test:logic` (runs all four offline `scripts/*.test.ts`). The
   `dev`/`start`/`simulate`/`check`/`memcheck`/`respcheck`/`stickycheck` scripts now resolve
   (`src/server.ts` exists; the four repointed scripts exist).

4. `src/web/` — already archived last session; no live copy existed. `.env.example` already
   documented every var (`PORT`, Supabase, 360dialog, `AGENT_ID`, `AGENT_COMPANY_NUMBER`,
   `BAILEYS_AUTH_DIR`). Nothing to change.

---

## Verification this session

- `npm run typecheck` → **clean**.
- `npm run test:logic` → all four pass (storelogic, baileyparse, qalogic, reminderlogic).
- **`server.ts` booted** (dummy creds, `PORT=3999`): express listened, `companyRouter`
  mounted, Baileys started + rendered a QR, the reminder tick ran on boot and its **only**
  failure was the Supabase network call (ECONNREFUSED to the dummy URL) — caught by the
  `.catch`, process stayed up. Proves the full wiring: dotenv-first ordering, all imports
  resolve, no crash on a failed reminder. Exactly the designed behavior.

### NOT verified (needs live creds — manual pass)
- `simulate/check/memcheck/respcheck/stickycheck` against a live Supabase + model key.
- `server.ts` against a real 360dialog webhook round-trip and a real Baileys QR scan.
- A real `runDailyReminders` send to the agent's number.

---

## Repo shape (final)

```
src/  server.ts brain.ts notify.ts qa.ts company.ts reminders.ts store.ts
      qualify.ts replies.ts memory.ts claude.ts listings.ts
      pipe/{types.ts, baileys.ts}  types/qrcode-terminal.d.ts
scripts/  simulate.ts memcheck.ts respcheck.ts stickycheck.ts   (brain checks, live store)
          storelogic.test.ts baileyparse.test.ts qalogic.test.ts reminderlogic.test.ts (offline)
supabase/schema.sql
```
- `src/` is still entirely untracked in git; nothing committed this session.
- `wacrm/`, `archive/` — out of scope.

---

## Suggested next steps (plan is done — these are wrap-up, not new phases)

- **Commit.** The whole `src/` rebuild + Phases 4–6 are uncommitted. Stage the new `src/`,
  `scripts/`, `supabase/`, and the `archive/` move; write the first real commit of the build.
- **`verify` / live pass** — with real Supabase + 360dialog creds, run `npm run check` and
  boot `server.ts` against the real webhook to confirm end-to-end before the broker uses it.
- **`code-review` / `/simplify`** — review the Phases 4–6 diff.
- **`ponytail-audit`** — sweep for leftover scaffolding (`archive/` cleanup, unused `bsp/`
  remnants) now that the plan is closed.

---

## Gotchas (carry-forward)

- **`notifyAgent` is live** — throws if `AGENT_COMPANY_NUMBER`/`DIALOG360_*` unset. In
  `server.ts` the reminder tick is `.catch`-wrapped, so a missing-creds run logs and the
  server survives; a direct `npm run` of a script that sends will still throw.
- **`STALE_MS` (3d, reminders) ≠ `QUIET_MS` (24h, store).** Don't collapse them.
- **Company-webhook gate:** with `AGENT_COMPANY_NUMBER` unset it answers ANY inbound text —
  set it in real deployments so only the agent's questions are handled.
- **Boot order:** `import "dotenv/config"` must stay the first line of `server.ts`.
- **`respcheck`/`stickycheck` now hit live Supabase** (not SQLite) — they need real creds and
  they write+delete throwaway `respcheck_agent`/`stickycheck_agent` rows.
- Baileys: don't keep WhatsApp Web open on the same number; QR scanned once via persisted auth.
