# Session Handoff — FourthspaceOS WhatsApp Assistant (Phase 6 complete + LIVE VERIFIED)

**Date:** 2026-07-22
**Branch:** master (uncommitted — still nothing committed; the whole `src/` rebuild is untracked)
**Plan:** `~/.claude/plans/claude-dot-md-is-buzzing-kitten.md` (6 phases) — **all 6 complete.**
**Source of truth:** `CLAUDE.md`
**This session:** finished Phase 6, then drove the WHOLE product live end-to-end for the first time.
**Prior handoffs:** `HANDOFF-phase6.md` (Phase 6 build), `HANDOFF-phase5.md`, `HANDOFF-phase4.md`, `HANDOFF-phase3.md`, `HANDOFF.md`.

---

## Headline: the product works live, end-to-end

A real client message now flows all the way through and the agent gets a suggestion card:

```
client (+91…) ──▶ agent's WhatsApp ──Baileys reads──▶ brain (qualify→replies)
                                                              │ notifyAgent()
                                                              ▼
                                        company number DMs the agent the card
```

**Verified live this session (real Supabase + real 360dialog + real WhatsApp):**
- Suggestion card arrives on the company number after a client texts the agent's number. ✅
- Lead qualification + 4 replies persist to Supabase. ✅
- Baileys read-pipe connected via QR (scanned once, auth in `baileys_auth/`). ✅
- 360dialog sender confirmed (the card physically arrived). ✅

---

## Phase 6 build (done — detail in HANDOFF-phase6.md)

- **`src/server.ts`** — thin bootstrap: dotenv first, express + `companyRouter` (`/company-webhook`),
  `startBaileys()`, `runDailyReminders()` on boot + `setInterval`. No lead-send / no web UI.
- **Repointed 4 brain self-checks** (`simulate/memcheck/respcheck/stickycheck`) from the dead
  `handleInbound`+SQLite API to `handleAgentMessage` + the async Supabase store.
- **`package.json`** — added `test:logic` (the 4 offline `scripts/*.test.ts`).
- `npm run typecheck` clean; all 4 offline logic tests pass.

---

## Live-session fixes & discoveries (NEW this session — these are the important carry-forwards)

### 1. `@lid` addressing bug — FIXED
Real WhatsApp messages arrive with a `remoteJid` like `7232909500553@lid` (WhatsApp's newer
privacy "linked-id"), NOT `…@s.whatsapp.net`. The old `toEvent` only accepted `@s.whatsapp.net`,
so it **silently dropped every real inbound message**. First live test = terminal silent.
- **Fix (`src/pipe/baileys.ts`):** accept `@lid` too; recover the real E.164 from
  `msg.key.senderPn` (`919717662666@s.whatsapp.net`), fall back to the lid id if absent.
- Added `@lid` cases to `scripts/baileyparse.test.ts` (passes).
- Added a `[baileys] in from … — handing to brain…` log so processing is visible in the terminal.

### 2. Duplicate suggestion cards — FIXED (verify live next run)
One client message produced TWO cards. Cause: `startBaileys()` re-runs on every auto-reconnect and
stacks another `messages.upsert` listener; also Baileys re-delivers on slow acks. The brain's DB
`waId` dedup loses the race (both reads see "not saved" before either writes).
- **Fix (`src/pipe/baileys.ts`):** in-process `seenWaIds` Set gates each `waId` before handoff
  (`alreadyHandled()`), bounded at 1000. Logs `duplicate message … skipping`.
- **NOT yet re-verified live** — confirm one-card-per-message on the next chat test.

### 3. Latency 63s → 3s — FIXED (~20x)
Cards took ~3 min because the model ran on **CPU**. Root cause was NOT model size — it was a
**stale Ollama server process** stuck in a CPU-only detection from an earlier boot. Hardware is
fine: **RTX 4060 Laptop, 8 GB VRAM, CUDA compute 8.9.**
- **Fix:** fully stop ALL `ollama` processes and restart `ollama serve` → it re-scans and finds the
  GPU (`inference compute … library=CUDA … RTX 4060 … available 7.2 GiB`).
- Also swapped the model: old `gemma4:e4b` was **9.6 GB (overflows 8 GB)**; now
  **`llama3.1:8b` (4.9 GB, 100% on GPU)**. `.env` `MODEL=llama3.1:8b` (was `gemma4:e4b`).
- Measured: a real `qualify` call went **63,404ms (CPU) → 2,967ms (GPU)**.
- **Trap to remember:** if Ollama ever reverts to CPU (`ollama ps` shows `vram=0MB`), it's the
  stale-process issue again — kill all ollama procs and restart. A plain restart re-scans the GPU.
- **Minor:** `llama3.1:8b` is slightly less precise (read a budget as "I.4" once). Fine for testing;
  revisit model choice only if extraction quality bites.

---

## Two OPEN items (decided, not built)

### A. Lead approval flow — the Dennis/Mitko problem (NEXT, biggest)
The pipe currently treats **every 1:1 chat as a lead**, so a colleague (Dennis) messaging the agent
got fed into the brain. **Decision (user):** on a NEW unknown number's first message, the bot DMs
the agent on the company number — "New contact +xxx — monitor as lead? yes/no" — and the agent
replies to opt them in. Only approved numbers get processed thereafter.
- This is **NEW behavior beyond CLAUDE.md's four features.** It extends the company-webhook inbound
  (today Q&A only) and needs a small store (pending + approved leads) plus a branch in the inbound
  flow. **Build deliberately, not a quick patch.**
- Saved to memory: `lead-allowlist-approval-flow`.

### B. Commit the build
The entire `src/` + `scripts/` rebuild (Phases 2–6) is **still untracked in git; zero commits this
session.** The `archive/` move is staged. First real commit of the new build is overdue.

---

## Repo shape (current)

```
src/  server.ts brain.ts notify.ts qa.ts company.ts reminders.ts store.ts
      qualify.ts replies.ts memory.ts claude.ts listings.ts
      pipe/{types.ts, baileys.ts}  types/qrcode-terminal.d.ts
scripts/  simulate.ts memcheck.ts respcheck.ts stickycheck.ts     (brain checks — live store)
          storelogic.test.ts baileyparse.test.ts qalogic.test.ts reminderlogic.test.ts (offline)
supabase/schema.sql
```
All of `src/` and `scripts/` is git-untracked. `wacrm/`, `archive/` — out of scope.

---

## How to run / test right now

1. **Ensure Ollama is on the GPU:** `ollama ps` should show `llama3.1:8b` with vram>0. If vram=0,
   kill all ollama processes and `ollama serve` again.
2. **`npm start`** — Baileys reconnects (no new QR), webhook mounts, reminder tick runs.
3. **Text the agent's number from another phone** posing as a client. Card should land on the
   company number in **seconds**.
4. **Memory/summaries:** send **7+ turns** (crosses `SUMMARIZE_AFTER = 6`) — then read the lead's
   `summary` column + `memory` table in Supabase to confirm the summary/facts captured the real
   conversation. (`npm run memcheck` tests this but on its OWN throwaway lead, not your chat.)

---

## Gotchas (carry-forward)

- **Ollama stale-process trap** (see fix #3) — the #1 thing to remember for latency.
- **`notifyAgent` is live** — throws if `AGENT_COMPANY_NUMBER`/`DIALOG360_*` unset. `.env` has all creds.
- **Don't open WhatsApp Web on the agent's number** while Baileys runs — they knock each other offline.
- **Baileys reconnect stacks listeners** — the `seenWaIds` guard covers duplicate processing, but the
  underlying listener-stacking is still there (harmless per-message now; `ponytail:`-flagged).
- **Company-webhook gate:** with `AGENT_COMPANY_NUMBER` unset it answers ANY inbound — it's set in `.env`.
- **`/company-webhook` is not a browser page** — it's where 360dialog POSTs. For the agent-Q&A feature
  to work externally you still need a public tunnel (ngrok) registered with 360dialog; not done/tested yet.
- **`STALE_MS` (baileys 10-min drop) & (reminders 3-day) & `QUIET_MS` (store 24h)** are three different
  thresholds — don't collapse them.
- Temp diagnostic scripts (`_envprobe/_llmprobe/_brainprobe/_speedcheck`) were created and **deleted**
  this session — none remain.

---

## Suggested next session

1. **Build the lead approval flow** (item A) — the main remaining feature.
2. **Commit the build** (item B) — first real commit of the Phase 2–6 rebuild.
3. **Finish the live memory/summary test** the user was mid-way through when latency interrupted.
4. Optionally: `/verify` the duplicate-card fix live; register `/company-webhook` via ngrok to test agent Q&A.
