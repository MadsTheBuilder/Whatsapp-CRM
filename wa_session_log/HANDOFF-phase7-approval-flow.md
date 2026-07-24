# Session Handoff — FourthspaceOS WhatsApp Assistant (Phase 7: lead approval gate built + committed)

**Date:** 2026-07-22
**Branch:** master
**First real commit landed this session:** `d79b238` — "FourthspaceOS Stage-1 rebuild + lead approval gate"
**Source of truth:** `CLAUDE.md`
**Prior handoff:** `HANDOFF-phase6-live-verified.md` (product working live end-to-end).

---

## What happened this session

1. **Built the lead approval gate** (the Dennis/Mitko problem — handoff item A). Done.
2. **Committed the entire build** (handoff item B) — the whole Phase 2–6 rebuild was untracked;
   it's now committed in ONE commit (`d79b238`) together with the approval flow. Clean history from here.
3. **Ran the DB migration** — `supabase/migrations/001_add_monitor.sql` executed successfully on
   live Supabase (user ran it in the SQL Editor). The `leads.monitor` column now exists; pre-existing
   leads were backfilled to `approved`.

**NOT done this session (all deferred to next — see test script below):**
- No live test of the approval flow.
- No live memory/summary test (was interrupted by latency last session, still pending).
- No latency re-measure after the Ollama model swap.

---

## The approval gate — what it does (so you don't re-derive it)

The read-pipe (Baileys) sees **every** 1:1 chat on the agent's number, so a colleague texting the
agent used to be treated as a lead. Now:

- **New unknown number** → lead row created as `monitor='pending'`, **the message is DROPPED**
  (not stored — decision was "drop until approved", no buffering), and the bot DMs the agent
  **tappable Yes/No buttons** on the company number.
- **Agent taps Yes** → `monitor='approved'` → from then on the brain processes normally.
- **Agent taps No** → `monitor='rejected'` → dropped forever, never re-prompted.
- **Pending/rejected** → every message dropped silently until approved.
- `listLeads()` returns **approved-only**, so pending/rejected never pollute counts or reminders.

**Why buttons, not typed yes/no:** each button's id carries the phone (`approve:<phone>` /
`reject:<phone>`), so a tap is unambiguous even with several pending contacts, AND a button tap is a
different WhatsApp message type from typed text — so approvals and Q&A can't be mistaken for each
other on the same company number.

### Files touched (all in commit d79b238)
- `src/store.ts` — added `Monitor` type + `monitor` on `Lead`; new `findLeadByPhone`,
  `createPendingLead` (returns `{lead, created}` so the prompt fires once under a race),
  `setMonitor`; `listLeads` now filters `monitor='approved'`. Removed dead `upsertLead`.
- `src/brain.ts` — the gate at the top of `handleAgentMessage` (pipe-agnostic seam).
- `src/notify.ts` — `askApproval(phone, name)` sends the interactive Yes/No buttons.
- `src/company.ts` — `parseApprovalId` (validates id, E.164 digits only — the gate's trust
  boundary) + `handleApproval`; webhook routes button taps → approval, text → existing Q&A.
- `supabase/schema.sql` — `monitor` column for fresh projects.
- `supabase/migrations/001_add_monitor.sql` — the ALTER for the live table (**already run**).
- `scripts/simulate.ts`, `scripts/memcheck.ts` — pre-approve their synthetic lead (else the gate
  drops their first message as pending). `scripts/approvallogic.test.ts` — new offline test.
- `package.json` — `approvallogic.test.ts` added to `test:logic`.

### Verified this session
- `npm run typecheck` — clean.
- `npm run test:logic` — all 5 offline tests pass (incl. the new approval-id parser test).
- **NOT verified live** — that's the whole job for next session.

---

## Template question — ANSWERED (no template needed)

The user asked whether a Meta-approved template is needed to test the Yes/No approval prompt.
**No.** The prompt goes to the AGENT on the company number, and interactive reply buttons are a
free-form message type allowed inside an **open 24-hour window**. The only catch: if the company
number has been silent toward the agent >24h, the window is closed and free-form is rejected.
**Workaround for testing: text the company number anything first ("hi") to reopen the window**, then
every approval prompt sails through. No template, no Meta approval process required for Stage-1 testing.

---

## ===== NEXT SESSION: FULL TEST SCRIPT (do this) =====

### 0. Pre-flight
- **Ollama on GPU:** `ollama ps` → must show the model with `vram>0`. If `vram=0MB`, kill ALL ollama
  processes and `ollama serve` again (the stale-process CPU trap — see phase-6 handoff fix #3).
  Note: `.env` `MODEL` — confirm which model is set (last session used `llama3.1:8b`; the user
  changed models through Ollama this session, so RE-CHECK `.env` `MODEL` before measuring latency).
- **Don't** open WhatsApp Web on the agent's number while Baileys runs — they knock each other offline.
- `npm start` — Baileys should reconnect with NO new QR; webhook mounts; reminder tick runs.
- **Open the 24h window:** from the agent's phone, text the COMPANY number "hi" (so approval buttons
  can be delivered free-form). Skip this and the Yes/No buttons may be rejected if the window is shut.

### 1. Approval flow — the new feature (test FIRST)
Goal: prove unknown numbers are gated and only approved ones become leads.

a. **From a NEW phone that has never texted the agent** (a "fresh colleague/lead"), text the AGENT's
   number once (e.g. "Hi, is the JVC apartment still available?").
b. **Expect on the company number:** an interactive message — *"New contact: +<number>. Monitor them
   as a lead?"* with **[Yes] [No]** buttons. (NO suggestion card should appear — the message was
   dropped pending approval.)
c. **Check Supabase:** `leads` row for that phone exists with `monitor='pending'`, and there is NO
   `messages` row for it yet (dropped, not stored).
d. **Tap [Yes].** Expect a confirmation DM: *"Got it — now monitoring +<number> as a lead."*
   `leads.monitor` flips to `approved`.
e. **Now text the agent's number AGAIN from that phone.** THIS time expect a normal suggestion card
   on the company number (qualify + 4 replies), and a `messages` row is stored.
f. **Rejection path:** repeat (a) from ANOTHER fresh number, tap **[No]**. Expect *"Okay — I'll
   ignore +<number>."*, `monitor='rejected'`, and further messages from it produce NOTHING.
g. **Q&A still works alongside approvals:** text the company number "how many leads am I working on?"
   — should get a count answer (typed text → Q&A path, not mistaken for an approval).

### 2. Latency re-measure (model changed this session)
The user swapped Ollama models this session — RE-MEASURE reply latency vs the phase-6 baseline.
- Baseline to beat (phase-6, `llama3.1:8b` on GPU): a real `qualify` call = **~2,967ms** (was
  63,404ms on CPU). Cards landed in seconds.
- **How to measure:** with an APPROVED lead, text the agent's number and time from send → card
  arriving on the company number. Or watch the server terminal logs (each stage logs). If it's back
  to minutes, it's the Ollama-on-CPU stale-process trap — kill all ollama, `ollama serve`, retry.
- Record the new model name (from `.env` `MODEL`) + measured latency in the next handoff. Also sanity
  check extraction quality (phase-6 note: `llama3.1:8b` misread a budget as "I.4" once — watch the
  new model's budget/area/requirement extraction on a real message).

### 3. Memory + summary test (was interrupted last session — finish it)
Goal: confirm the rolling summary + durable facts capture a REAL conversation (not the throwaway
`npm run memcheck` lead — that tests its own synthetic lead).
- Use an **approved** lead (approve it via step 1 first).
- Send **7+ inbound turns** from that phone (crosses `SUMMARIZE_AFTER = 6`), a realistic Dubai
  property conversation (budget, area, buy/rent, a couple of personal facts like "young kid, near a
  school").
- **Check Supabase after turn 7+:** the lead's `summary` column is populated and reads like the real
  conversation; the `memory` table has ≥1 durable fact for that lead.
- If summary/facts look thin or wrong, note it — may be the new model's summarization quality.

### 4. Optional / lower priority
- `/verify` the duplicate-card fix live (phase-6 fix #2 — was fixed but never re-verified: confirm
  ONE card per message, not two).
- Register `/company-webhook` via ngrok with 360dialog so agent Q&A works from outside (never tested
  end-to-end externally — needs a public tunnel).

---

## Gotchas (carry-forward — still all true)

- **Ollama stale-process trap** — #1 latency cause. `ollama ps` vram=0 ⇒ kill all ollama + `ollama serve`.
- **`.env MODEL` changed this session** — re-check it before measuring latency; record the new value.
- **24h window** — text the company number first so approval buttons deliver free-form (no template).
- **`baileys_auth/` is now gitignored** — live WhatsApp session keys, never commit it.
- **Don't run `supabase/schema.sql` on the live DB** — it `drop`s tables and wipes data. The migration
  (`001_add_monitor.sql`) is the safe path and is already applied.
- **Don't open WhatsApp Web on the agent's number** while Baileys runs.
- **`notifyAgent`/`askApproval` are live** — throw if `AGENT_COMPANY_NUMBER`/`DIALOG360_*` unset (all in `.env`).
- **Company-webhook gate:** with `AGENT_COMPANY_NUMBER` set it only answers that number.
- **`STALE_MS` (10-min baileys drop) ≠ (3-day reminders) ≠ `QUIET_MS` (24h store)** — three thresholds, don't merge.
- **Baileys reconnect stacks listeners** — `seenWaIds` guard covers duplicate processing (harmless per-message; `ponytail:`-flagged).

---

## Repo shape (current)

```
src/  server.ts brain.ts notify.ts qa.ts company.ts reminders.ts store.ts
      qualify.ts replies.ts memory.ts claude.ts listings.ts
      pipe/{types.ts, baileys.ts}  types/qrcode-terminal.d.ts
scripts/  simulate.ts memcheck.ts respcheck.ts stickycheck.ts          (brain checks — live store)
          storelogic/baileyparse/qalogic/reminderlogic/approvallogic.test.ts  (offline, in test:logic)
supabase/  schema.sql  migrations/001_add_monitor.sql
```
All committed as of `d79b238`. `wacrm/`, `archive/` — out of scope (`wacrm/` now gitignored).

---

## Suggested next-session order
1. **Run the full test script above, section by section** (approval → latency → memory/summary).
2. Record new model name + measured latency + extraction/summary quality in the next handoff.
3. Then optional: duplicate-card verify, ngrok for external Q&A.
