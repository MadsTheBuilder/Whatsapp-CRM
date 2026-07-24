# Control Center Dashboard — Build Implementation Plan

> Execute this in a fresh session. Plan only — nothing here has been built yet.
> Visual mockup already exists at `mockups/control-center.html` (3 views:
> dashboard → agent Kanban → lead detail + read-only WhatsApp chat panel).

## Context

We have a working WhatsApp assistant (FourthspaceOS Stage-1). The bot watches an
agent's lead chats (read via Baileys today, 360dialog later) and privately helps
the agent. All lead data — contacts, transcripts, budget/area/requirement,
summaries — already lives in Supabase, keyed by `agent_id` on every row.

We now want a **Control Center dashboard**: a web UI that shows each agent
connected to the company number, and on clicking an agent, a CRM **Kanban board**
of their leads by sales stage. Clicking a lead opens a full-screen detail page
(name, phone, budget, requirements, summary) with a **read-only WhatsApp-style
chat panel** on the right rendering the stored transcript.

This plan wires that existing mockup to the real system.

**Why this is mostly a read layer:** ~70% of what the dashboard shows already
exists in `src/store.ts`. The one genuinely new concept is an **8-stage sales
pipeline** — the current `stage` column is a 3-value conversation-depth heuristic
(`first_contact`/`following_up`/`deep`), not a sales pipeline, and it already
drives reply tone in `replies.ts`, so we must NOT overload it.

**Scope note (from CLAUDE.md):** dashboards are listed as "not in v1 unless we
decide we need one." This is that deliberate decision. Build for **one agent
now**; the schema is already multi-tenant-shaped (`agent_id` everywhere +
`unique(agent_id, phone)`), so 360dialog multi-agent later needs no redesign.

## Decisions (confirmed with user)

- **New `pipeline` column**, separate from existing `stage`. 8 values:
  `new | no_reply | qualifies | details_sent | meeting_done | eoi | deal_closed | waste`.
- **`no_reply` is a real stored column value** (not a live badge). Set
  automatically by the existing daily reminder tick (which already finds silent
  leads); the agent moves leads *out* of it manually.
- **Stage control = dashboard + WhatsApp command** (both).
- **Data refresh = load + manual refresh button** on the UI (no auto-poll).
- Chat panel stays **read-only** — bot never sends to leads (hard rule).

## Who sets each pipeline stage

| Stage | Set by |
|---|---|
| `new` | Auto — on lead approval (fresh approved lead defaults to `new`) |
| `no_reply` | Auto — daily reminder tick, when `responsiveness()` returns `no_reply` |
| `qualifies`, `details_sent`, `meeting_done`, `eoi`, `deal_closed`, `waste` | Agent — dashboard dropdown/drag OR WhatsApp `stage` command |

> The bot cannot know a meeting happened, so those six are human-set. `new` and
> `no_reply` are free — the system already computes both.

---

## Files & changes

### 1. Migration — `supabase/migrations/002_add_pipeline.sql` (new)
- `alter table leads add column pipeline text not null default 'new';`
- Add a CHECK constraint restricting to the 8 values (guards typos from the
  WhatsApp command path).
- `alter add ... default 'new'` already backfills existing rows to `'new'`.
- Follow the existing migration style in `supabase/migrations/001_add_monitor.sql`.

### 2. Store functions — `src/store.ts` (ADD ONLY; do NOT touch existing `stage` logic)
- Add `export type Pipeline = "new" | "no_reply" | "qualifies" | "details_sent" | "meeting_done" | "eoi" | "deal_closed" | "waste";`
- Add `pipeline: Pipeline;` to the `Lead` interface (`store.ts:20`).
- **`setPipeline(agentId, id, pipeline)`** — near-mirror of existing
  `setMonitor()` (`store.ts:85`): update-by-key, return whether a row matched,
  bump `updated_at`.
- **`listAgents()`** — distinct `agent_id`s with aggregate counts (total leads,
  qualified-ish, no_reply). One grouped query over `monitor='approved'` rows.
  For one agent it returns one row — correct.
- **`leadsForBoard(agentId)`** — reuse `listLeads()` (`store.ts:226`, already
  filters to `monitor='approved'`). Return leads plus each lead's live
  `responsiveness()` state (`store.ts:249`) so the card can show
  active/awaiting. (Board GROUPING is by the stored `pipeline` column, not by
  responsiveness.)
- Reuse existing `getLead` (`store.ts:100`) and `getMessages` (`store.ts:166`)
  for the detail + chat endpoints as-is.

### 3. Read/write API — `src/server.ts` + new `src/api.ts` (new router)
Server already exists and hosts webhooks (`src/server.ts:18`). Add one
`apiRouter` (new `src/api.ts`, mirror the `companyRouter` structure in
`company.ts`) mounted with `app.use(apiRouter)`. All handlers use the
service-role store — Supabase is **never** exposed to the browser (preserves the
existing security model). `AGENT_ID` from env, exactly as `company.ts:6`.

Routes:
- `GET  /api/agents` → `listAgents()` → dashboard cards
- `GET  /api/agents/:agentId/board` → `leadsForBoard()` grouped by `pipeline` → Kanban
- `GET  /api/leads/:id` → `getLead()` → detail fields + summary
- `GET  /api/leads/:id/messages` → `getMessages()` → chat transcript
- `POST /api/leads/:id/pipeline` `{ pipeline }` → `setPipeline()` → dashboard move

Validate the incoming `pipeline` against the 8 allowed strings before writing
(defense in depth alongside the DB CHECK).

### 4. WhatsApp stage command — `src/company.ts` (ADD one handler)
- Add `parseStageCommand(text)` next to existing `parseApprovalId()`
  (`company.ts:14`). Grammar: `stage <phone> <pipeline>` where phone is E.164
  digits (reuse the `/^\d{6,15}$/` guard already there) and pipeline is one of
  the 8 values. Return `null` if not a stage command → falls through to Q&A.
- Wire into the POST handler at `company.ts:83`, in the same
  `handleApproval → else if text` chain: try approval, then stage command, then
  Q&A. On success call `setPipeline()` and `notifyAgent()` a confirmation
  (`"✓ +<phone> → Meeting done"`), matching the existing approval-reply pattern.
- Use **phone** (not name) — avoids the two-Rohans collision.

### 5. Dashboard UI — `mockups/control-center.html` → served frontend
- Serve the static file: add `app.use(express.static(...))` in `server.ts`, or
  serve the single file at `GET /`. Keep it one file; no build step.
- Replace the hardcoded `AGENTS` array with `fetch()` calls to the API routes.
- The 3 views already exist in the mockup — keep them.
- Add a **Refresh button** in the topbar (and on the board header) that re-runs
  the current view's fetch. Show a subtle "loaded Xm ago" timestamp.
- Lead detail: add a **stage dropdown** (the 8 values) →
  `POST /api/leads/:id/pipeline`, then re-fetch. (Drag-between-columns is a
  nice-to-have; dropdown is the v1 primary.)
- Chat panel input stays **disabled / read-only** (hard rule).

---

## Build order (each step ships independently)

1. **Migration** — add `pipeline` column. Board has something to group by.
2. **Store + API** — `setPipeline`, `listAgents`, `leadsForBoard` + the 5 routes.
3. **UI wiring** — point mockup at the API + refresh button. *Read-only control
   center is now live.*
4. **Stage setting** — dashboard dropdown + WhatsApp `stage` command +
   reminder-tick auto-`no_reply`. *Kanban is now interactive.*

### Auto no_reply wiring (part of step 4)
`src/reminders.ts` already runs every 24h and finds 3-day-silent leads via
`responsiveness()`. Extend that pass to also call
`setPipeline(agentId, id, 'no_reply')` for leads whose responsiveness is
`no_reply` **AND** whose current pipeline is an early/neutral stage — only
auto-demote from `new` / `qualifies` / `details_sent`. Do NOT clobber
`eoi` / `deal_closed` / `waste`. Keep the guard explicit.

---

## Verification (end-to-end)

1. **Migration:** run `002_add_pipeline.sql` on Supabase; confirm
   `leads.pipeline` exists, defaults `'new'`, and the CHECK rejects a bogus value
   (`update leads set pipeline='xxx'` should error).
2. **API smoke test:** start the server, then
   `curl localhost:3000/api/agents`, `/api/agents/<AGENT_ID>/board`,
   `/api/leads/<id>`, `/api/leads/<id>/messages` — verify real Supabase data
   comes back grouped correctly.
3. **Pipeline write (dashboard path):**
   `curl -X POST localhost:3000/api/leads/<id>/pipeline -d '{"pipeline":"meeting_done"}'`
   → re-GET the board → lead is in the Meeting done column.
4. **Pipeline write (WhatsApp path):** simulate a company-number inbound (reuse
   `scripts/simulate.ts` if present, or the existing company-webhook test flow)
   with body `stage <phone> eoi` → confirm the lead moves and the agent gets the
   `✓` DM.
5. **UI:** open `localhost:3000/` — dashboard loads real agents → click agent →
   real Kanban → click lead → real detail + real transcript in the chat panel.
   Click **Refresh** → data re-fetches. Confirm chat input is disabled.
6. **Auto no_reply:** trigger the reminder tick (`runDailyReminders()`) against a
   lead whose last message is outbound >24h old → confirm it lands in No reply,
   and that a `deal_closed` lead is NOT demoted.
7. **Existing behavior intact:** run the current test suite (`scripts/*.test.ts`)
   — the untouched `stage`/qualify/reply logic must still pass. The new
   `pipeline` column must not affect `deriveStage()` or reply tone.

## Guardrails
- Do **not** modify existing `stage` (`store.ts:14`), `deriveStage()`
  (`brain.ts:28`), or the qualify/reply flow. `pipeline` is additive.
- Board and all counts stay filtered to `monitor='approved'` (approval gate).
- No Supabase credentials in the browser — all DB access via the server.
- One file for the UI, no frontend build step (fewest moving parts).
