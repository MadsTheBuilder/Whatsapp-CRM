# Implementation Plan — FourthspaceOS Stage-1 WhatsApp Assistant

## Context

`CLAUDE.md` is the single source of truth and explicitly supersedes every earlier plan
("this file wins"). The product is a **read-only WhatsApp assistant for one Dubai
real-estate agent**: a bot on a **company number** that quietly watches the agent's
conversations with leads and privately helps the agent via four features — suggested
replies, lead summaries, daily follow-up reminders, and questions-on-demand. **The bot
never messages a lead.**

The repo today contains an older build (`src/`, "FourthspaceOS Stage-1 MVP") that got the
**brain right** but the **architecture wrong** relative to CLAUDE.md. The gaps:

| CLAUDE.md rule | Current `src/` reality | Action |
|---|---|---|
| Storage = **Supabase**, no local DB file | `src/store.ts` uses local SQLite `fourthspace.db` | **Migrate to Supabase** |
| Bot is **read-only toward leads**; agent sends replies by hand | `/api/send` sends to the lead's phone; web inbox lets agent send | **Remove send-to-lead + web inbox** |
| Read the **agent's number via Baileys** (swappable pipe), 360dialog later | No Baileys; webhook treats the *sender* as the lead | **Add Baileys read-pipe behind a seam** |
| Bot **sends to the agent** on the company number (360dialog) | `dialog360.ts` sender exists but only used to notify a broker phone | **Wire all 4 agent-facing outputs** |
| Follow-up reminders (daily, 3-day silence) | Missing | **Build a daily scheduler** |
| Questions on demand (agent texts company number) | Missing | **Build 360dialog inbound → intent → answer** |

**Decisions confirmed with the user:** build against the standalone `src/` bot (the
`wacrm/` Next.js CRM is **out of scope**); migrate to Supabase now; build the full Baileys
read-pipe now; wire all four agent-facing outputs via the 360dialog company-number sender
and remove the lead-send path and web inbox.

**Reused as-is (the brain is done — do NOT rewrite):**
- [src/qualify.ts](src/qualify.ts) — `qualify(messages, memory)` → budget/area/requirement/next_question
- [src/replies.ts](src/replies.ts) — `suggestReplies(...)` → exactly 4 options
- [src/memory.ts](src/memory.ts) — `summarize(...)` + `memoryBlock(...)` (rolling summary + facts)
- [src/claude.ts](src/claude.ts) — `structured<T>()` LLM wrapper (OpenRouter/Ollama, fallback chain)
- [src/listings.ts](src/listings.ts) — `findMatchingListings(...)` (PropertyFinder via local API)
- [src/bsp/dialog360.ts](src/bsp/dialog360.ts) — the company-number sender (correct as-is)

---

## The core reframe (read before touching code)

There are now **two distinct inbound sources**, not one:

1. **Agent's number (Baileys, read-only).** Messages here are between the **agent and a
   lead**. Each event carries `direction` (was it the lead or the agent who spoke) and the
   **lead's number** as the conversation key. This drives the brain (qualify → summarize →
   suggest). The bot's *output* is a private suggestion sent to the agent on the company
   number.

2. **Company number (360dialog, read + send).** Inbound here is the **agent texting the
   bot** a question ("how many qualified leads?"). This does **not** touch the qualify
   loop — it routes to a Q&A handler that answers from the store.

The current [src/webhook.ts](src/webhook.ts) `handleInbound(phone, body, name, waId)`
conflates "sender == lead". The refactor makes the brain consume **one normalized event**
regardless of pipe, keyed by `leadNumber` with an explicit `direction`.

**The seam (build this first, everything hangs off it):**
```ts
// src/pipe/types.ts
export interface AgentMessageEvent {
  agentId: string;       // which agent's number this came from (env AGENT_ID for now)
  leadNumber: string;    // the LEAD's E.164 number (conversation key), not the agent's
  direction: "in" | "out"; // "in" = lead→agent, "out" = agent→lead (agent's own sent msg)
  text: string;
  timestamp: number;     // ms epoch
  waId?: string;         // provider message id for dedup (optional)
  leadName?: string;
}
```
Baileys feeds this from its `messages.upsert` event; a future 360dialog agent-number
webhook feeds the same shape. **The brain never learns which pipe produced it.**

---

## Changes

### Phase 0 — Dependencies & config

- **Add deps:** `@whiskeysockets/baileys` (Baileys), `@supabase/supabase-js`, and
  `qrcode-terminal` (print the login QR). Baileys also needs `pino` (its logger peer).
- **Rewrite [.env.example](.env.example)** to the real shape:
  ```
  # LLM (unchanged — OpenRouter free chain or local Ollama)
  OPENROUTER_API_KEY=
  LLM_BASE_URL=https://openrouter.ai/api/v1
  MODEL=google/gemma-4-31b-it:free
  MODEL_FALLBACKS=nvidia/nemotron-3-nano-30b-a3b:free,meta-llama/llama-3.3-70b-instruct:free

  # Supabase (NEW — replaces fourthspace.db)
  SUPABASE_URL=
  SUPABASE_SERVICE_ROLE_KEY=

  # Company number — 360dialog send + inbound (bot talks to the AGENT only)
  DIALOG360_API_KEY=
  DIALOG360_API_URL=
  DIALOG360_VERIFY_TOKEN=fourthspace-verify

  # The AGENT the bot helps — their company-number chat id (where suggestions land)
  AGENT_ID=agent_demo
  AGENT_COMPANY_NUMBER=      # E.164 no + — the agent's WhatsApp, on the company channel

  # Baileys read-pipe (agent's number). Auth keys persisted under ./baileys_auth
  BAILEYS_AUTH_DIR=./baileys_auth

  PORT=3000
  ```
  Drop `ANTHROPIC_API_KEY`, `BSP`, `META_*`, `AGENT_PHONE` from the documented surface
  (BSP selection collapses — 360dialog is the only sender now; see Phase 4).

### Phase 1 — Supabase storage (replace SQLite)

- **Wipe & recreate schema in Supabase.** Author `supabase/schema.sql` (new) mirroring the
  proven SQLite shape from [src/store.ts:10-48](src/store.ts#L10-L48) — tables `leads`,
  `messages`, `memory`, every row carrying `agent_id`. Postgres types: `bigserial` PK,
  `timestamptz` for `updated_at`/`ts`, `unique(agent_id, phone)` on leads, partial unique
  index `messages(agent_id, wa_id) where wa_id is not null` for dedup. Include
  `summary_upto` (as `bigint`, referencing message id) and `next_question`/`replies_json`/
  `summary` columns. (The user is wiping the junk Supabase project per CLAUDE.md.)
- **Rewrite [src/store.ts](src/store.ts)** to use `@supabase/supabase-js` (service-role
  client) while **keeping the exact same exported function signatures** so
  qualify/replies/memory/webhook callers don't change:
  `upsertLead, getLead, updateLeadQualification, saveMessage, getMessages, saveMemory,
  getFacts, listLeads, responsiveness`, plus `Lead`/`Message`/`Stage` types.
  - `saveMessage` must still return `false` on duplicate `wa_id` — use
    `insert ... on conflict do nothing` and check the returned row count.
  - `updateLeadQualification`'s sticky-field COALESCE becomes: build the update object with
    only non-null keys (omit null keys so Postgres never overwrites) — same semantics as the
    SQLite `COALESCE`, validated by `stickycheck`.
  - `responsiveness` stays a derived read (last message direction + age); no stored column.
  - Supabase calls are async — the store functions become `async`. Callers in `webhook.ts`
    already `await`; update the few synchronous call sites (`server.ts` threadView, scripts)
    to await. **This is the main ripple; grep every caller.**
- **Delete** the SQLite file references and the hand-rolled migration blocks
  ([src/store.ts:50-77](src/store.ts#L50-L77)).

### Phase 2 — The pipe seam + refactor the brain to consume events

- **New [src/pipe/types.ts](src/pipe/types.ts):** the `AgentMessageEvent` interface above.
- **Refactor [src/webhook.ts](src/webhook.ts) `handleInbound`** into
  **`handleAgentMessage(ev: AgentMessageEvent)`** in a new
  **[src/brain.ts](src/brain.ts)** (move the orchestration out of the Meta-webhook file,
  which is being deleted):
  - Upsert lead by `ev.leadNumber` (+ `ev.leadName`).
  - Save the message with `ev.direction` and `ev.waId` (dedup unchanged).
  - **Only run qualify/summarize/suggest when `direction === "in"`** (the lead said
    something new — that's when the agent needs a suggestion). An `"out"` message (the agent
    replied to the lead) is stored for transcript/summary continuity and **resets
    responsiveness**, but does not generate a suggestion.
  - Keep the stage derivation, memory watermark, qualify, listings, suggestReplies logic
    verbatim ([src/webhook.ts:52-98](src/webhook.ts#L52-L98) is reused almost unchanged).
  - **Output:** instead of the old broker-notify block, call the new
    `notifyAgent(...)` (Phase 4) to DM the agent the lead's message + numbered suggestions.
- **Delete Meta webhook** ([src/webhook.ts](src/webhook.ts) GET/POST `/webhook`) — the
  agent's number is no longer read via a Meta-shaped webhook; it's read via Baileys.
  (If a 360dialog agent-number webhook is wanted later, it's a thin adapter that emits the
  same `AgentMessageEvent` — note this as the documented swap point, don't build it now.)

### Phase 3 — Baileys read-pipe (agent's number)

- **New [src/pipe/baileys.ts](src/pipe/baileys.ts):**
  - `useMultiFileAuthState(BAILEYS_AUTH_DIR)` so the QR is scanned **once** and keys persist
    across restarts (CLAUDE.md requirement).
  - On `connection.update`: print QR via `qrcode-terminal` on first login; **auto-reconnect**
    on drop unless the disconnect reason is `loggedOut` (then a fresh QR is required) — this
    is the documented Baileys reconnect pattern (`DisconnectReason.loggedOut`).
  - On `messages.upsert`: for each text message, normalize to `AgentMessageEvent`:
    - `leadNumber` = the JID's phone (strip `@s.whatsapp.net`), for both directions the
      **lead's** number is the chat counterpart.
    - `direction` = `msg.key.fromMe ? "out" : "in"` (fromMe = the agent typed it).
    - `text` = extract from `conversation` / `extendedTextMessage.text`.
    - `waId` = `msg.key.id`; `timestamp` = `msg.messageTimestamp * 1000`.
    - Skip group chats and non-text for the first cut (`ponytail:` text-only, add media
      captions if needed).
    - Call `handleAgentMessage(ev)`.
  - Export `startBaileys()` called from `server.ts` at boot.
  - **Ignore stale backlog** on reconnect the same way the old webhook did — drop events
    older than a `STALE_MS` window so a prior session's messages don't reappear
    ([src/webhook.ts:144-148](src/webhook.ts#L144-L148) pattern).

### Phase 4 — 360dialog company-number: send + agent Q&A inbound

- **Sender (send-only path to the agent):**
  - Keep [src/bsp/dialog360.ts](src/bsp/dialog360.ts) as the transport. Collapse the BSP
    selector — the only sender is 360dialog. Simplify [src/bsp/index.ts](src/bsp/index.ts)
    to export a single `companySend(to, body)` (or keep `makeBSP()` returning the 360dialog
    impl; **delete `meta.ts` and `mock.ts`** unless a mock is wanted for offline tests — keep
    a tiny console mock behind an env flag for local dev is acceptable, `ponytail:`).
  - **New [src/notify.ts](src/notify.ts):** `notifyAgent(body)` sends to
    `AGENT_COMPANY_NUMBER` via `companySend`. All four features funnel their agent-facing
    output through here.
  - **Suggestion card** (feature 1): moved verbatim from
    [src/webhook.ts:102-113](src/webhook.ts#L102-L113) into `handleAgentMessage`, sent via
    `notifyAgent`.
- **Company-number inbound webhook (agent Q&A — feature 4):**
  - **New route in [src/server.ts](src/server.ts):** `GET /company-webhook` (360dialog
    verify handshake, `DIALOG360_VERIFY_TOKEN`) + `POST /company-webhook`. 360dialog delivers
    the Meta message shape (`entry[0].changes[0].value.messages[0]`), so the parser mirrors
    the old Meta parser ([src/webhook.ts:136-161](src/webhook.ts#L136-L161)).
  - Inbound here is **from the agent** (`msg.from === AGENT_COMPANY_NUMBER`). Route the text
    to **new [src/qa.ts](src/qa.ts)** `answerAgentQuestion(text): Promise<string>`:
    - Classify intent with `structured<T>()` (reuse the LLM wrapper) into a small enum:
      `count_leads | count_qualified | count_no_reply | summarize_lead(phone/name) |
      unknown`. Then answer from the store (`listLeads`, filter by qualified =
      budget&&area&&requirement present, or `responsiveness === "no_reply"`).
    - `summarize_lead` returns the stored `summary` + `facts` for the named lead.
    - `unknown` → a short "I can tell you lead counts, qualified counts, or a lead's
      summary" help string.
    - `ponytail:` LLM intent + direct store queries; no NLU framework.
  - Reply via `notifyAgent(answer)`.

### Phase 5 — Daily follow-up reminders (feature 3)

- **New [src/reminders.ts](src/reminders.ts):** `runDailyReminders()`:
  - `listLeads(AGENT_ID)`, compute `responsiveness` per lead, select leads whose last
    contact (last message ts) is **> 3 days** ago and where the ball is in the agent's court
    (last direction `out` and silent, or `no_reply`).
  - Compose one digest message ("3 leads need a nudge: Ahmed (JVC 2BR) — 4 days quiet; …")
    and `notifyAgent(digest)`. One message, not N (`ponytail:` single digest; per-lead if the
    agent asks).
  - **Schedule:** a single `setInterval`/daily timer in `server.ts` computing "once per day",
    or simplest: check on boot + every 24h. `ponytail: in-process daily timer; move to a
    real cron/edge function when the box isn't always-on.` Note the 3-day threshold and the
    daily cadence are **tunable constants** at the top of the file.

### Phase 6 — Remove the lead-send path & web inbox

- **[src/server.ts](src/server.ts):** delete `/api/send` (sends to the lead — forbidden),
  `/api/threads`, `/api/threads/:id`, the static `web/` serving, and `/api/properties`
  (the inbox/properties UI). Keep only: boot Baileys, mount `/company-webhook`, start the
  reminder timer. `server.ts` shrinks to a small bootstrap.
- **Delete** [src/web/](src/web/) (inbox.html, inbox.js, properties.html, properties.js,
  listings.json) — CLAUDE.md: no web UI unless we decide we need one; we decided no.
- **Update [scripts/](scripts/)**: `simulate.ts` / `memcheck.ts` / `respcheck.ts` /
  `stickycheck.ts` currently call `handleInbound` / store functions. Repoint them at
  `handleAgentMessage(AgentMessageEvent)` and `await` the now-async store. These are the
  self-checks that guard the brain — keep them working.

---

## Critical files

**New:** `supabase/schema.sql`, [src/pipe/types.ts](src/pipe/types.ts),
[src/pipe/baileys.ts](src/pipe/baileys.ts), [src/brain.ts](src/brain.ts),
[src/notify.ts](src/notify.ts), [src/qa.ts](src/qa.ts), [src/reminders.ts](src/reminders.ts).

**Rewritten:** [src/store.ts](src/store.ts) (SQLite→Supabase, async),
[src/server.ts](src/server.ts) (bootstrap only), [.env.example](.env.example),
[package.json](package.json) (deps).

**Refactored:** [src/webhook.ts](src/webhook.ts) → logic moves to `brain.ts`; Meta webhook
deleted. [src/bsp/index.ts](src/bsp/index.ts) collapses to the 360dialog sender.

**Deleted:** [src/web/](src/web/), [src/bsp/meta.ts](src/bsp/meta.ts) (Meta send path).

**Untouched (reused):** qualify.ts, replies.ts, memory.ts, claude.ts, listings.ts,
dialog360.ts.

---

## Verification (end-to-end)

1. **Typecheck:** `npm run typecheck` — clean (catches the async-store ripple).
2. **Brain self-checks (no network):** repoint and run `npm run check`, `npm run memcheck`,
   `npm run respcheck`, `npm run stickycheck` against the Supabase store — proves qualify,
   4 replies, rolling summary+facts, responsiveness states, and sticky-field COALESCE all
   still hold after the storage swap.
3. **Supabase wiring:** run a `simulate` inbound, then confirm in the Supabase dashboard
   that `leads`/`messages`/`memory` rows appear with the right `agent_id`.
4. **Baileys read-pipe:** `npm run dev`, scan the QR **once**; from a second phone send a
   message to the developer's (agent's) number → confirm the console/logs show the
   normalized `AgentMessageEvent`, the lead+message land in Supabase, and a suggestion card
   is sent to `AGENT_COMPANY_NUMBER` via 360dialog. Restart the server → confirm **no new QR**
   (persisted auth) and auto-reconnect.
5. **Read-only guarantee:** grep the codebase for any send to a lead number — there must be
   none. Every `companySend`/`notifyAgent` target is `AGENT_COMPANY_NUMBER`.
6. **Questions on demand:** text the company number "how many qualified leads?" and
   "summarize Ahmed" → confirm correct counts/summary come back to the agent.
7. **Reminders:** seed a lead with a >3-day-old last outbound message, invoke
   `runDailyReminders()` (or a `npm run remindercheck`) → confirm a single digest arrives at
   the agent's number and fresh leads are excluded.

---

## Notes / deliberate simplifications (ponytail)

- **One agent** (`AGENT_ID` from env) — every row still carries `agent_id`, so multi-agent
  is a later config change, not a redesign (CLAUDE.md).
- **In-process daily timer** for reminders — fine for an always-on dev box; swap to real
  cron/Supabase scheduled function for production.
- **360dialog is the only sender**; a mock console-sender behind an env flag is kept only for
  offline local runs.
- **The 360dialog agent-number webhook (later production read-pipe)** is *not* built now —
  it's the documented swap point: a thin adapter emitting `AgentMessageEvent`, no brain change.
- **Q&A intent** is a small LLM classifier + direct store queries, not an NLU framework.
