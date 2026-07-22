# Plan: Lead-Intelligence AI layer inside WACRM

## Context

We built a WhatsApp AI qualification loop in the standalone MVP at `src/` (FourthspaceOS
Stage-1): **inbound → qualify (budget/area/requirement) → N human-worded reply options →
agent picks → send**, plus a rolling per-lead conversation summary. The goal now is to
reproduce that behavior *at a high level* inside the real product, **WACRM**
(`wacrm/`, Next.js 16 + Supabase), so a broker connects their WhatsApp number and the AI
agent lives inside their CRM — reading each lead's thread, suggesting replies, and keeping a
running summary per lead in the pipeline.

**Key finding that shapes this plan:** WACRM already has a mature AI layer
(`wacrm/src/lib/ai/*`) — provider-agnostic LLM calls (Anthropic/OpenAI BYO-key), an
auto-reply bot, a single-draft endpoint, knowledge-base RAG, usage logging, and a webhook
that already dispatches AI work in an `after()` block. This is therefore an **extend/reuse**
task, not build-from-scratch. We add three MVP behaviors the CRM is missing, reusing every
existing primitive.

**Decisions (from the user):**
- **Reply mode: suggestions only** — the agent always picks/edits before anything sends
  (distinct from the existing auto-send bot, which stays available separately).
- **3 suggestions** per generation (MVP used 4).
- **Qualification** (budget/area/requirement) → **structured columns on `contacts`** (so
  suggestions can use them and leads stay filterable).
- **Rolling summary** → **appended as a new `contact_notes` row each refresh**, so it shows
  up in the lead's notes within the pipeline view (a dated history, not one evolving note).

## What already exists (REUSE — do not rebuild)

- `wacrm/src/lib/ai/generate.ts` → `generateReply({config, systemPrompt, messages})` — the
  one LLM entry point. Providers return **raw text only** (no tool-calling) —
  `wacrm/src/lib/ai/providers/anthropic.ts` / `openai.ts`.
- `wacrm/src/lib/ai/config.ts` → `loadAiConfig(db, accountId, {requireActive})` — decrypted
  `AiConfig`; works with both the RLS SSR client and the admin client.
- `wacrm/src/lib/ai/context.ts` → `buildConversationContext(db, conversationId, limit)` →
  `ChatMessage[]` (last N text msgs, oldest-first, customer=user / agent+bot=assistant).
- `wacrm/src/lib/ai/defaults.ts` → `buildSystemPrompt(...)`, env tunables.
- `wacrm/src/lib/ai/usage.ts` → `logAiUsage(...)`; `admin-client.ts` → `supabaseAdmin()`.
- Webhook `wacrm/src/app/api/whatsapp/webhook/route.ts` → `processMessage()` ends its
  `after()` block (~L799-811) calling `dispatchInboundToAiReply(...)`. **This is the seam** to
  hook qualify + summarize into (runs after the 200 to Meta; own try/catch; never throws).
- Draft endpoint `wacrm/src/app/api/ai/draft/route.ts` (single reply) + its UI button (the
  Sparkles button) in `wacrm/src/components/inbox/message-composer.tsx` (`handleDraft`,
  ~L260-299, button ~L712-727). The suggestions picker is modeled on this exact wiring.
- Lead panel `wacrm/src/components/inbox/contact-sidebar.tsx` — already renders deals, notes,
  tags per contact; where qualification + summary-notes surface.
- Auth: routes use `requireRole('agent')` (`wacrm/src/lib/auth/account.ts`); tenancy is
  `account_id` everywhere; `contacts`/`contact_notes` already RLS-scoped.

**Structured-output approach (leanest, no adapter changes):** since providers return raw
text, get JSON out via a JSON-only system prompt + `generateReply` + `JSON.parse` inside a
try/catch that returns a safe default on failure. No tool-calling plumbing added.
`ponytail:` naive parse, no re-prompt on bad JSON — add a single retry only if parse
failures show up in logs.

## Changes

### 1. Migration — `wacrm/supabase/migrations/037_lead_intelligence.sql`

Additive `ADD COLUMN IF NOT EXISTS` on `contacts` (matches the existing migration style; no
new RLS — contacts are already account-scoped):

```sql
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS budget TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS area TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS requirement TEXT;
-- Watermark: created_at of the last message folded into the summary.
-- (The summary text itself lives in contact_notes, not here.)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS summary_upto TIMESTAMPTZ;
```

Note: **no summary/facts columns** — per the decision, the summary is written to
`contact_notes`. We keep only the watermark on the contact so re-summarization stays
incremental (flat token cost, MVP's core trick).

`contact_notes` already has: `id, contact_id, user_id, note_text, created_at` — enough. Tag
AI notes by a text prefix (e.g. lead with `🤖 AI summary — `) so the UI can style them and
the writer can find the prior summary to carry context forward.

### 2. New lib files (pure, no side effects)

- **`wacrm/src/lib/ai/qualify.ts`** — `qualifyLead(config, messages) → {budget, area,
  requirement}` (JSON-prompt extraction; concrete values only, vague → null) and
  `mergeQualification(prior, incoming)` implementing **sticky-field COALESCE in JS**:
  `incoming.x ?? prior.x` — a null from the model never wipes a known value; a non-null
  correction overwrites. This is the MVP's `stickycheck` semantics.
- **`wacrm/src/lib/ai/summarize.ts`** — `summarizeConversation(config, newMessages,
  priorSummary) → { summary }` folding only messages since the watermark into the prior
  summary (carried forward as text in the prompt). Export `SUMMARIZE_AFTER_MESSAGES = 6`.
  `ponytail:` drop the MVP's separate `facts[]` array for a first cut — a single rich
  summary paragraph in a note covers the ask; add structured facts only if the notes prove
  too coarse.
- **`wacrm/src/lib/ai/suggest.ts`** — `suggestReplies(config, messages, {budget, area,
  requirement}) → string[]` returning **exactly 3** (hard slice/pad, no re-prompt — MVP's
  guarantee). Discovery-first prompt: don't invent specifics for unknown fields.

All three reuse `generateReply` + `buildSystemPrompt`; all catch and return a safe default.

### 3. Webhook dispatch — `wacrm/src/lib/ai/lead-intelligence.ts` + one call site

New `dispatchLeadIntelligence({accountId, conversationId, contactId})`:
1. `loadAiConfig(db, accountId, {requireActive:false})`; bail if no AI config.
2. `buildConversationContext(db, conversationId)`; bail if empty.
3. Load current `contacts` row (budget/area/requirement/summary_upto) + customer message
   count for this conversation.
4. **Qualify:** `mergeQualification(prior, await qualifyLead(...))`; build an update object
   containing **only changed non-null keys** (this is the COALESCE — null keys are simply
   omitted from the UPDATE, so SQL never overwrites with null).
5. **Summarize** when customer msg count ≥ `SUMMARIZE_AFTER_MESSAGES`: re-fetch messages
   **after `summary_upto`** (needs `created_at`), fold into the prior summary (read from the
   latest AI `contact_notes` row), then **INSERT a new `contact_notes` row** with the fresh
   summary and set `contacts.summary_upto` to the newest message's `created_at`.
6. Best-effort `logAiUsage`.
7. Whole body in try/catch — never throws into the webhook.

Wire it in `wacrm/src/app/api/whatsapp/webhook/route.ts` right after the
`dispatchInboundToAiReply(...)` block (~L811), same guard (`!interactiveReplyId &&
inboundText.trim()`), awaited inside the existing `after()`.

### 4. Suggestions endpoint — `wacrm/src/app/api/ai/suggest/route.ts`

Modeled on `draft/route.ts`: `requireRole('agent')`, same rate-limit keys, verify the
conversation belongs to the account, `loadAiConfig`, `buildConversationContext`, load the
contact's budget/area/requirement, call `suggestReplies`, return `{ suggestions: string[] }`
(length 3). Read-only — sends nothing.

### 5. Inbox UI — `wacrm/src/components/inbox/message-composer.tsx`

Add next to the existing Sparkles draft button: a "suggest replies" button →
`POST /api/ai/suggest` → open a small `Dialog` (the component already imports `Dialog*`)
listing the 3 options; clicking one fills the textarea (reusing the exact focus/height
pattern from `handleDraft`) for the agent to edit and send. No auto-send.

Optionally surface budget/area/requirement in `contact-sidebar.tsx` alongside deals/notes
(the AI summary already appears there via the new `contact_notes` rows). `ponytail:` sidebar
display is a nice-to-have — the data lands regardless; add the read-only fields if the
broker wants them at a glance.

## What to skip for the first cut (ponytail)

- **Auto-send / handoff bot changes** — leave the existing auto-reply bot untouched; this is
  a parallel suggestions-only path.
- **`facts[]` structured memory** — one summary note per refresh covers the ask.
- **Embeddings / KB retrieval in suggest** — add if replies need grounding in docs.
- **Re-prompt on bad JSON, per-field confidence** — add only if logs show parse failures.
- **Per-conversation (vs per-contact) qualification** — MVP model is one lead = one contact;
  revisit only if a contact has genuinely distinct simultaneous inquiries.

## Verification (end-to-end)

WACRM has no local BSP simulator like the MVP's `npm run simulate`, so drive the webhook
directly. Note the webhook **HMAC-verifies** the body (`verifyMetaWebhookSignature`), so
tests must either sign the payload with the account's `verify_token`/app secret or call a
thin test harness that invokes `processMessage`/`dispatchLeadIntelligence` directly with the
service-role client.

1. **Typecheck/lint:** `cd wacrm && npm run typecheck` (+ existing `vitest` if touched).
2. **Qualification + sticky fields:** POST an inbound stating a budget → confirm
   `contacts.budget` populates. POST a follow-up that omits budget → confirm budget is
   **unchanged** (COALESCE holds). POST a correction → confirm it overwrites. (This is the
   MVP's `stickycheck` reproduced against Postgres.)
3. **Summary note:** POST ≥6 customer messages on one thread → confirm a new
   `🤖 AI summary` row appears in `contact_notes` and `contacts.summary_upto` advances; POST
   more and confirm the next note folds prior context (watermark works, no full re-read).
4. **Suggestions:** `POST /api/ai/suggest {conversation_id}` → confirm exactly 3 strings;
   in the inbox, click the new button → dialog shows 3 options → picking one fills the
   composer and nothing sends until Send.
5. **Webhook resilience:** force an LLM failure (bad key) and confirm the inbound still
   stores the message and returns 200 (lead-intelligence swallowed its error).

## Critical files

- `wacrm/supabase/migrations/037_lead_intelligence.sql` (new)
- `wacrm/src/lib/ai/qualify.ts`, `summarize.ts`, `suggest.ts`, `lead-intelligence.ts` (new)
- `wacrm/src/app/api/ai/suggest/route.ts` (new)
- `wacrm/src/app/api/whatsapp/webhook/route.ts` (one call after ~L811)
- `wacrm/src/components/inbox/message-composer.tsx` (suggest button + dialog)
- `wacrm/src/components/inbox/contact-sidebar.tsx` (optional field display)
