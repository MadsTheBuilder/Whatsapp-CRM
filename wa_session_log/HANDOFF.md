# Session Handoff — FourthspaceOS WhatsApp Assistant

**Date:** 2026-07-22
**Branch:** master
**Plan:** `~/.claude/plans/claude-dot-md-is-buzzing-kitten.md` (6 phases)
**This session completed:** Phase 0 + Phase 1 (verified against live Supabase).

---

## What this product is (one paragraph)

Read-only WhatsApp assistant for one Dubai real-estate agent. A bot on a
**company number** (360dialog) quietly watches the agent's chats with leads and
privately DMs the agent four things: suggested replies, lead summaries, daily
3-day-silence reminders, and answers to on-demand questions. **The bot never
messages a lead.** The agent's own number is read via a **swappable pipe**
(Baileys now, 360dialog later) that feeds one normalized `AgentMessageEvent`
into the brain — so the brain never knows which pipe produced a message. Storage
is **Supabase** (no local DB). Full rules live in `CLAUDE.md` — it is the single
source of truth and overrides all older plans/docs.

---

## Done this session — Phase 0 + Phase 1

### Phase 0 — deps & config
- `package.json` deps added: `@supabase/supabase-js`, `@whiskeysockets/baileys`,
  `pino`, `qrcode-terminal`. Kept `@anthropic-ai/sdk` (only its `InputSchema`
  *type* is used by `src/claude.ts`, no runtime call). `npm install` clean, 0 vulns.
- `.env.example` rewritten to the new shape (OpenRouter chain, Supabase,
  360dialog company number, `AGENT_COMPANY_NUMBER`, `BAILEYS_AUTH_DIR`). Dropped
  `ANTHROPIC_API_KEY`/`BSP`/`META_*`/`AGENT_PHONE`. **No secrets in it.**

### Phase 1 — Supabase storage (replaces SQLite)
- **`supabase/schema.sql`** (new): `leads` / `messages` / `memory`, `bigserial`
  PKs, `timestamptz`, `unique(agent_id, phone)`, partial unique index
  `messages(agent_id, wa_id) where wa_id is not null` for dedup, `summary_upto
  bigint` watermark. Drops-then-creates (the wipe). **Already applied to the live
  Supabase project.**
- **`src/store.ts`** (new, the SQLite→Supabase rewrite): service-role client, all
  functions now `async`, **same exported signatures/types** as the old SQLite
  store so Phase 2+ callers slot in unchanged: `upsertLead, getLead,
  updateLeadQualification, saveMessage, getMessages, saveMemory, getFacts,
  listLeads, responsiveness` + `Lead`/`Message`/`Stage`/`Responsiveness` types.
- **`scripts/storelogic.test.ts`** (new): offline self-check for the two pure bits
  of hand-written logic — the sticky null-omit rule + the ISO-`timestamptz` parse.
  Run: `npx tsx scripts/storelogic.test.ts`.

### Bug found & fixed by the live test (important)
First `saveMessage` used `.upsert(..., { onConflict: "agent_id,wa_id" })`. The
dedup index is **partial** (`where wa_id is not null`), and Postgres `ON CONFLICT`
**cannot target a partial index by column list** → runtime error. Fixed to a plain
insert that catches the unique-violation (`error.code === "23505"`) → returns
`false`. This respects the partial index exactly: null `wa_id` always inserts
(outbound/simulated rows), duplicate non-null `wa_id` is a no-op re-delivery.

### Verification run (all green, against REAL Supabase)
- `npx tsc --noEmit` → clean.
- Live round-trip test exercised & passed: upsert idempotency (name not
  overwritten), wa_id dedup, sticky COALESCE (null pass doesn't wipe
  budget/area), memory replace+dedup+bullet-strip, responsiveness state machine,
  `listLeads`. DB left **clean/empty** afterward.

---

## Environment / credentials state

- **`.env` (local, gitignored)** now holds the live Supabase URL + service-role
  key, and was migrated to the new shape (carried over the existing OpenRouter +
  DIALOG360 values, mapped old `AGENT_PHONE=+971581871500` →
  `AGENT_COMPANY_NUMBER=971581871500`). `LLM_BASE_URL` still points at local
  Ollama (`gemma4:e4b`) — that's the dev box's working setup.
- **Supabase project ref:** `aymtpqpqwqfpbsbreniy` (region resolved as
  ap-southeast-1; direct host is IPv6-only).
- **DB password** was needed only to apply the schema (via a throwaway `pg`
  script, since supabase-js can't run DDL and `psql` isn't installed). The app
  itself uses only the service-role key, **not** the DB password — so the DB
  password can be reset anytime with zero impact. Both the DB password and the
  service-role key appeared in the chat transcript; rotate if that matters.

---

## Repo shape right now (read before Phase 2)

- The **entire old `src/` was archived** to `archive/src/` before this session.
  `src/` currently contains **only `store.ts`**. That's why `npm run typecheck`
  is clean — nothing imports the store yet.
- **The brain is done and must NOT be rewritten** — it lives in `archive/src/`
  and gets restored + repointed at the async store in later phases:
  - `qualify.ts` — `qualify(messages, memory)` → budget/area/requirement/next_question
  - `replies.ts` — `suggestReplies(...)` → exactly 4 options
  - `memory.ts` — `summarize(...)` + `memoryBlock(...)`
  - `claude.ts` — `structured<T>()` LLM wrapper (OpenRouter/Ollama fallback chain)
  - `listings.ts` — `findMatchingListings(...)` (PropertyFinder via local API)
  - `bsp/dialog360.ts` — the company-number sender (correct as-is)
- Archived self-check scripts to repoint in Phase 6: `archive/scripts/{simulate,
  memcheck,respcheck,stickycheck}.ts`. `package.json` still lists their npm
  scripts (`check`, `memcheck`, `respcheck`, `stickycheck`) — they currently point
  at `scripts/*` paths that don't exist yet.
- `wacrm/` (Next.js CRM) is **out of scope** — ignore it.

---

## NEXT — Phase 2 (the pipe seam + brain.ts)

1. **`src/pipe/types.ts`** — the seam interface:
   ```ts
   export interface AgentMessageEvent {
     agentId: string;       // env AGENT_ID for now
     leadNumber: string;    // the LEAD's E.164 (conversation key), NOT the agent's
     direction: "in" | "out"; // in = lead→agent, out = agent→lead
     text: string;
     timestamp: number;     // ms epoch
     waId?: string;         // provider msg id for dedup
     leadName?: string;
   }
   ```
2. **`src/brain.ts`** — move `handleInbound` orchestration out of the (to-be-deleted)
   `archive/src/webhook.ts` into `handleAgentMessage(ev: AgentMessageEvent)`:
   - upsert lead by `ev.leadNumber` (+ `leadName`), save message with `direction`
     + `waId` (dedup unchanged).
   - **Only run qualify/summarize/suggest when `direction === "in"`.** An `"out"`
     message is stored (transcript/summary continuity, resets responsiveness) but
     generates no suggestion.
   - reuse the stage-derivation / memory-watermark / qualify / listings /
     suggestReplies logic ~verbatim from `archive/src/webhook.ts:52-98`.
   - output: call `notifyAgent(...)` (Phase 4) instead of the old broker-notify block.
   - the store is now async — `await` everywhere.
3. Do **not** rebuild the Meta webhook. The agent number is read via Baileys
   (Phase 3). A 360dialog agent-number webhook is the documented later swap point.

Remaining after that: Phase 3 Baileys read-pipe, Phase 4 360dialog send +
agent-Q&A inbound, Phase 5 daily reminders, Phase 6 delete lead-send/web-inbox +
repoint scripts. See the plan file for each phase's detail.

---

## Gotchas for the next session

- **supabase-js can't run DDL.** To re-apply/reset the schema, connect directly
  with a Postgres driver (a `pg` script) using the DB password, or paste
  `supabase/schema.sql` into the dashboard SQL Editor. `psql` is not installed;
  the Supabase CLI is present but not logged-in/linked.
- **Partial unique index + ON CONFLICT don't mix** — that's why `saveMessage`
  uses insert-then-catch-23505. Don't "simplify" it back to an upsert.
- `src/store.ts` **throws at import** if `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`
  are unset — so any script touching the store needs `import "dotenv/config"`.
- Postgres returns `ts` as ISO-8601 `timestamptz`; `responsiveness` uses
  `Date.parse` directly (the old SQLite `" "→"T"` + `Z` hack is gone).
