# Session Handoff — FourthspaceOS WhatsApp Assistant

**Date:** 2026-07-22
**Branch:** master
**Plan:** `~/.claude/plans/claude-dot-md-is-buzzing-kitten.md` (6 phases)
**This session completed:** Phase 4 — 360dialog company-number sender (real) + agent Q&A inbound. (Prior: Phase 0+1 in `HANDOFF.md`, Phase 2+3 in `HANDOFF-phase3.md`.)
**Next:** Phase 5 — daily follow-up reminders (`src/reminders.ts`).

---

## Done this session — Phase 4

### The sender is now real (was a console stub)
- **`src/notify.ts`** rewritten: `notifyAgent(body)` now sends via a private
  `companySend(to, body)` that POSTs to 360dialog (`DIALOG360_API_URL/messages`,
  `D360-API-KEY` header, Meta text-message schema). Target is always
  `AGENT_COMPANY_NUMBER` — throws if unset. **The BSP selector is collapsed away:**
  360dialog is the only sender, so the transport is inlined into `notify.ts`. No
  `src/bsp/` directory exists (the old `dialog360.ts`/`meta.ts`/`index.ts`/`mock.ts`
  stay in `archive/src/bsp/`, now superseded — leave them; deleting archive is churn).
- **The suggestion card in `brain.ts` needed no change** — it already funnels through
  `notifyAgent`. Suggestions now actually reach the agent (once creds are in `.env`).

### Agent Q&A (feature 4)
- **`src/qa.ts`** (new): `answerAgentQuestion(text): Promise<string>`.
  - LLM classifies intent via `structured<T>()` into
    `count_leads | count_qualified | count_no_reply | summarize_lead | unknown`
    (plus a `lead` name/number field for `summarize_lead`).
  - Answers straight from the store: `listLeads`, `getFacts`, `responsiveness`.
    - **qualified** = `budget && area && requirement` all non-null (same rule as
      `brain.ts` `wasQualified` — exported as `isQualified`).
    - **no_reply** = `responsiveness().state === "no_reply"` (checked per lead).
    - **summarize_lead** = `findLead()` loose match (name substring, case-insensitive,
      OR phone-suffix on ≥4 digits) → returns stored `summary` + `facts`.
    - **unknown** → a short help string listing what it can answer.
  - `ponytail:` LLM intent + direct store queries, no NLU framework.
- **`src/company.ts`** (new): `companyRouter` — the company-number inbound webhook.
  - `GET /company-webhook`: verify handshake against `DIALOG360_VERIFY_TOKEN`.
  - `POST /company-webhook`: parses the Meta shape (`entry[0].changes[0].value.messages[0]`,
    mirrors the old `archive/src/webhook.ts` parser). Gates on `msg.type === "text"` AND
    (`AGENT_COMPANY_NUMBER` unset OR `msg.from === AGENT_COMPANY_NUMBER`) so only the
    agent's own questions are answered and delivery/read `statuses` callbacks are ignored.
    Routes text → `answerAgentQuestion` → `notifyAgent(answer)` (fire-and-forget so a
    failed reply doesn't 500 and trigger a 360dialog retry). Always `res.sendStatus(200)`.

### Decision made on the handoff's open question (Phase 4 step 4)
The route lives in **its own router file (`src/company.ts`)**, NOT a new `server.ts`.
Reason: the plan says "don't build `server.ts` twice" — Phase 6 rewrites `server.ts` to
a bootstrap. `company.ts` is a mountable `Router`, so Phase 6's `server.ts` mounts it in
one line (`app.use(companyRouter)`) alongside `startBaileys()` + the reminder timer.
**`server.ts` still does not exist** — do not run `npm run dev`/`start` yet.

---

## Verification run this session (all green)

- `npx tsc --noEmit` → **clean**.
- **`npx tsx scripts/qalogic.test.ts`** (new) → **passed**. Exercises the pure
  answering logic: `isQualified` (all-three rule) and `findLead` (name substring,
  phone-suffix ≥4 digits, under-4 rejected, empty needle). The LLM intent classify is
  NOT unit-tested (needs a live model) — it's a thin `structured()` call. Dummy Supabase
  creds let the module import offline (supabase-js is lazy).
- `npx tsx scripts/baileyparse.test.ts` → still **passed** (no regression).
- **Read-only guarantee:** `grep -rn "companySend\|sock.sendMessage\|\.send(" src/` → the
  only hits are `res.send(challenge)` (HTTP handshake) and `companySend` (called solely by
  `notifyAgent` → `AGENT_COMPANY_NUMBER`). No `sock.sendMessage` anywhere. The bot cannot
  message a lead.

### NOT verified (needs live creds / provider — manual pass later)
- Real 360dialog send: needs `DIALOG360_*` + `AGENT_COMPANY_NUMBER` in `.env` and the
  live channel. The request shape matches the proven `archive/src/bsp/dialog360.ts`.
- Live company-webhook round-trip (agent texts "how many qualified leads?" → answer back):
  needs `server.ts` (Phase 6) mounting `companyRouter`, a public URL, and 360dialog
  webhook config. Parser + routing are code-verified; the HTTP round-trip is a manual step.
- LLM intent accuracy: needs a live model (OpenRouter/Ollama).

---

## Repo shape right now (read before Phase 5)

```
src/
  brain.ts        handleAgentMessage(ev)   — orchestration (unchanged this session)
  notify.ts       notifyAgent(body)        — REAL 360dialog sender now
  qa.ts           answerAgentQuestion(text) — LLM intent + store answers  [NEW]
  company.ts      companyRouter            — GET/POST /company-webhook     [NEW]
  store.ts        async Supabase store
  qualify.ts  replies.ts  memory.ts  claude.ts  listings.ts   — the brain (unchanged)
  pipe/
    types.ts      AgentMessageEvent seam
    baileys.ts    startBaileys() read-pipe
  types/qrcode-terminal.d.ts
scripts/
  storelogic.test.ts   baileyparse.test.ts   qalogic.test.ts  [NEW]
supabase/schema.sql
```

- **Still in `archive/src/`, repoint in later phases:**
  - `server.ts` — **Phase 6** rewrites to a small bootstrap: `startBaileys()` +
    `app.use(companyRouter)` + start reminder timer. Deletes `/api/send`,`/api/threads`,web/.
  - `bsp/*` — superseded by inlined `companySend` in `notify.ts`; nothing to restore.
  - `webhook.ts` — the Meta webhook stays deleted (logic ported to brain.ts + company.ts).
  - `web/` — deleted in Phase 6.
- `wacrm/` (Next.js CRM) — **out of scope, ignore.**

---

## NEXT — Phase 5 (daily follow-up reminders, feature 3)

1. **`src/reminders.ts`** (new): `runDailyReminders()`:
   - `listLeads(AGENT_ID)`, compute `responsiveness` per lead.
   - Select leads where the ball is in the AGENT's court and it's gone quiet
     **> 3 days**: last direction `out` and silent, or `state === "no_reply"`.
     (Note: store's `QUIET_MS` is 24h — the reminder threshold is a separate, longer
     3-day constant. Compute the >3-day gap from the last message ts / `silent_ms`.)
   - Compose ONE digest ("3 leads need a nudge: Ahmed (JVC 2BR) — 4 days quiet; …")
     and `notifyAgent(digest)`. Single message, not N (`ponytail:`).
   - **Tunable constants at top of file:** the 3-day threshold and daily cadence.
2. **Schedule:** the plan puts the daily timer in `server.ts` (Phase 6). Simplest:
   a `setInterval` / check-on-boot-then-every-24h in the Phase-6 `server.ts` bootstrap.
   For Phase 5, just build + self-check `runDailyReminders()` (seed a >3-day-old lead,
   assert the digest names it and excludes fresh leads); wire the timer in Phase 6.
   `ponytail: in-process daily timer; move to cron/edge function when the box isn't always-on.`

Then Phase 6: rebuild `server.ts` bootstrap (mount `companyRouter`, `startBaileys()`,
reminder timer), delete lead-send/web, repoint `simulate/memcheck/respcheck/stickycheck`.

---

## Gotchas for the next session

- **`notifyAgent` throws if `AGENT_COMPANY_NUMBER`/`DIALOG360_*` unset** — it's real now,
  no more console stub. Scripts that trigger a brain suggestion or a Q&A answer without
  those env vars will throw at send time (the brain wraps its `notifyAgent` in
  `.catch`, so the loop survives; a direct `runDailyReminders()` will surface the throw).
- **`server.ts` still doesn't exist.** `npm run dev`/`start` → nothing to run.
  Working today: `npx tsx scripts/storelogic.test.ts`, `scripts/baileyparse.test.ts`,
  `scripts/qalogic.test.ts`, and `npm run typecheck`. The `check/memcheck/respcheck/
  stickycheck` scripts are still in `archive/scripts/` (repointed in Phase 6).
- **`src/store.ts` throws at import** if `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` unset.
  Offline tests set dummy values (supabase-js is lazy — never connects until a query runs;
  `qalogic.test.ts` only calls the pure helpers, so no query fires).
- **Company-webhook gate:** if you leave `AGENT_COMPANY_NUMBER` unset in dev, the webhook
  answers ANY inbound text (the gate is `!agentNumber || from === agentNumber`). Set it in
  real deployments so only the agent's questions are answered.
- Baileys warnings from prior sessions still apply (don't keep WhatsApp Web open on the
  same number; QR scanned once via persisted auth).
