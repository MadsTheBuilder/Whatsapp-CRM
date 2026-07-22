# Session Handoff — FourthspaceOS WhatsApp Assistant

**Date:** 2026-07-22
**Branch:** master
**Plan:** `~/.claude/plans/claude-dot-md-is-buzzing-kitten.md` (6 phases)
**This session completed:** Phase 2 + Phase 3. (Prior session: Phase 0 + Phase 1 — see `HANDOFF.md`.)
**Next:** Phase 4 — 360dialog company-number: real sender + agent Q&A inbound.

---

## What this product is (one paragraph)

Read-only WhatsApp assistant for one Dubai real-estate agent. A bot on a
**company number** (360dialog) quietly watches the agent's chats with leads and
privately DMs the agent four things: suggested replies, lead summaries, daily
3-day-silence reminders, and answers to on-demand questions. **The bot never
messages a lead.** The agent's own number is read via a **swappable pipe**
(Baileys now, 360dialog later) that feeds one normalized `AgentMessageEvent`
into the brain — so the brain never knows which pipe produced a message. Storage
is **Supabase** (no local DB). Full rules live in `CLAUDE.md` — single source of
truth, overrides all older plans/docs.

---

## Done this session — Phase 2 + Phase 3

### Phase 2 — the pipe seam + brain.ts
- **`src/pipe/types.ts`** (new): the `AgentMessageEvent` seam interface
  (`agentId, leadNumber, direction "in"|"out", text, timestamp, waId?, leadName?`).
  Every read-pipe emits this exact shape; the brain never learns which pipe produced it.
- **`src/brain.ts`** (new): `handleAgentMessage(ev)` — the `handleInbound` loop ported
  out of the (to-be-deleted) `archive/src/webhook.ts`. Changes from the original:
  - keyed by `ev.leadNumber` + explicit `ev.direction` (no more "sender == lead").
  - **`await` on the now-async store everywhere** (`upsertLead`, `saveMessage`,
    `getMessages`, `getFacts`, `saveMemory`, `updateLeadQualification`).
  - **Direction gate:** an `"out"` message (agent's own reply) is stored — for
    transcript/summary continuity + it resets responsiveness — then returns early.
    Only `"in"` (the lead spoke) runs qualify → summarize → listings → 4 replies.
  - stage-derivation / memory-watermark / qualify / listings / suggestReplies logic
    is verbatim from the old webhook.
  - the old `AGENT_PHONE`-gated broker-notify block is replaced by an unconditional
    `notifyAgent(card)` (fire-and-forget; a failed DM must not fail the loop).
- **`src/notify.ts`** (new): `notifyAgent(body)` — the single outbound seam all four
  features funnel through. **Currently a console stub** (`console.log`). Phase 4 swaps
  the body for the real 360dialog `companySend(AGENT_COMPANY_NUMBER, body)`; callers
  don't change. **No message actually reaches the agent yet.**
- **Restored 5 brain modules from `archive/src/` → `src/` unchanged:** `qualify.ts`,
  `replies.ts`, `memory.ts`, `claude.ts`, `listings.ts`. They only import the store's
  *types* (`Message`, `Stage`) and call `structured()`/`fetch` — **none touch store
  functions**, so they compile against the async store with zero edits.

### Phase 3 — Baileys read-pipe (agent's number)
- **`src/pipe/baileys.ts`** (new): `startBaileys()` — reads the agent's own WhatsApp:
  - `useMultiFileAuthState(BAILEYS_AUTH_DIR)` → QR scanned **once**, keys persist.
  - Renders the QR with `qrcode-terminal` (in-lib `printQRInTerminal` is deprecated;
    we render it ourselves from the `connection.update` `qr` field).
  - **Auto-reconnect on every drop EXCEPT `DisconnectReason.loggedOut` (401)** — a real
    logout invalidates creds, so the only fix is deleting `BAILEYS_AUTH_DIR` + a fresh scan.
  - `messages.upsert` → normalize each text to `AgentMessageEvent` → `handleAgentMessage`.
  - Exported pure parser: `toEvent`, `jidToNumber`, `messageText`.
  - **Drops:** group chats (`@g.us`), status (`@broadcast`), non-text (media/reaction).
    `direction = fromMe ? "out" : "in"`; `leadNumber` = counterpart JID digits.
  - **Two-layer stale-backlog defense:** ignore non-`"notify"` batches (history-sync on
    restart) **plus** a `STALE_MS = 10min` window (a live re-delivery after a long
    outage still carries its original timestamp).
- **`src/types/qrcode-terminal.d.ts`** (new): one-line ambient shim (the pkg ships no
  types; skipped `@types/qrcode-terminal` — a dep for one function is overkill).
- Uses `@hapi/boom` (already a Baileys dep) to read the disconnect status code.

---

## Verification run this session (all green)

- `npx tsc --noEmit` → **clean** after every phase.
- **`npx tsx scripts/baileyparse.test.ts`** (new) → **passed**. Exercises the REAL
  `toEvent`: in/out direction, JID→number strip (incl. `:device` part), text vs
  extendedText extraction, and the drop rules (group / status / image / whitespace).
  Uses dummy Supabase creds so the module imports without a live connection
  (supabase-js is lazy — it never connects until a query runs, and the parser never queries).
- **Read-only guarantee:** `grep -rn "sock.sendMessage\|\.send(" src/` → **none**. The
  Baileys pipe cannot message a lead.
- `scripts/storelogic.test.ts` (from prior session) still valid.

### NOT verified (needs hardware / interactive — do in a later manual pass)
- Live Baileys QR scan + reconnect (plan step 4): needs the agent's phone + a scan.
  Parser + wiring are unit-verified; the actual connect is a manual step.
- End-to-end brain against live Supabase: the repointed `simulate.ts` (Phase 6) covers this.

---

## Repo shape right now (read before Phase 4)

```
src/
  brain.ts        handleAgentMessage(ev)  — the orchestration
  notify.ts       notifyAgent(body)       — CONSOLE STUB (Phase 4 makes it real)
  store.ts        async Supabase store (Phase 1)
  qualify.ts  replies.ts  memory.ts  claude.ts  listings.ts   — the brain (restored, unchanged)
  pipe/
    types.ts      AgentMessageEvent seam
    baileys.ts    startBaileys() read-pipe
  types/
    qrcode-terminal.d.ts
scripts/
  storelogic.test.ts   baileyparse.test.ts
supabase/schema.sql    (applied to live Supabase — Phase 1)
```

- **Still in `archive/src/`, restore/repoint in later phases:**
  - `bsp/dialog360.ts` — the company-number sender (correct as-is; **Phase 4** wires it
    into `notify.ts` via a collapsed `companySend`, deletes `bsp/meta.ts` + `bsp/index.ts`
    selector).
  - `server.ts` — **Phase 6** rewrites to a small bootstrap (boot Baileys + mount
    `/company-webhook` + start reminder timer; deletes `/api/send`, `/api/threads`, web/).
  - `webhook.ts` — the Meta webhook is **deleted** (logic already ported to brain.ts).
  - `web/` — deleted in Phase 6.
- `wacrm/` (Next.js CRM) — **out of scope, ignore.**

---

## NEXT — Phase 4 (360dialog sender + agent Q&A)

1. **Make the sender real.** Restore `archive/src/bsp/dialog360.ts`. Collapse the BSP
   selector — 360dialog is the only sender. Simplest: export a single
   `companySend(to, body)` (or keep `makeBSP()` returning the dialog360 impl). Delete
   `bsp/meta.ts` + `bsp/mock.ts` (keep a tiny console mock behind an env flag only if a
   local offline run is wanted — `ponytail:`).
2. **`src/notify.ts`:** replace the `console.log` body with
   `companySend(AGENT_COMPANY_NUMBER, body)`. The suggestion card in `brain.ts` already
   funnels through `notifyAgent` — no brain change needed.
3. **`src/qa.ts`** (new): `answerAgentQuestion(text): Promise<string>` — classify intent
   with `structured<T>()` into a small enum (`count_leads | count_qualified |
   count_no_reply | summarize_lead(phone/name) | unknown`), answer from the store
   (`listLeads`, filter qualified = budget&&area&&requirement present, or
   `responsiveness === "no_reply"`). `unknown` → short help string. `ponytail:` LLM
   intent + direct store queries, no NLU framework.
4. **Company-number inbound webhook** (feature 4): this goes in `server.ts`, which
   Phase 6 rebuilds. **Decision for next session:** either add a minimal `server.ts` now
   with just `GET/POST /company-webhook` (360dialog verify handshake +
   Meta-shaped parser, mirrors `archive/src/webhook.ts:118-161`), routing agent text →
   `answerAgentQuestion` → `notifyAgent(answer)`; or defer the route to Phase 6 and only
   build `qa.ts` + the sender now. The plan groups the route under Phase 4 but the file
   it lives in is a Phase-6 rewrite — pick one, don't build `server.ts` twice.

Remaining: Phase 5 daily reminders (`src/reminders.ts`), Phase 6 delete lead-send/web +
rebuild `server.ts` bootstrap + repoint `simulate/memcheck/respcheck/stickycheck` scripts.

---

## Gotchas for the next session

- **`notifyAgent` is a stub** — nothing reaches the agent until Phase 4 wires the sender.
- **`package.json` scripts are stale/dangling:** `dev`/`start` → `src/server.ts` (doesn't
  exist yet — Phase 6). `check`/`memcheck`/`respcheck`/`stickycheck` → `scripts/*.ts`
  files not yet restored (still in `archive/scripts/`, repointed in Phase 6). Don't run
  those yet. The two that WORK today: `npx tsx scripts/storelogic.test.ts` and
  `npx tsx scripts/baileyparse.test.ts`, plus `npm run typecheck`.
- **`src/store.ts` throws at import** if `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` unset
  — any script touching it (directly or via `brain.ts`/`baileys.ts`) needs those env
  vars, or dummy values for offline parser tests (supabase-js is lazy).
- **Baileys warnings from prior session's `HANDOFF.md` still apply:** don't keep WhatsApp
  Web open on the same number while Baileys is connected; save auth so QR is scanned once.
- **`makeWASocket` is the default export** in Baileys 6.7.x (also named). `printQRInTerminal`
  is deprecated in-lib — we render the QR ourselves.
- From prior session (still true): supabase-js can't run DDL; partial-unique-index +
  ON CONFLICT don't mix (that's why `saveMessage` uses insert-then-catch-23505 — don't
  "simplify" it to an upsert); Supabase project ref `aymtpqpqwqfpbsbreniy`.
