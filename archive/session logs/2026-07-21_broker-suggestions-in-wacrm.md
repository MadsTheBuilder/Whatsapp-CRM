# Session Log — Lead-Intelligence + broker suggestions in WACRM (2026-07-21)

**Outcome:** Shipped the FourthspaceOS lead-intelligence loop (qualify → rolling summary →
suggested replies) into the real product **WACRM** (Next.js 16 + Supabase), plus a new
capability: pushing the suggested replies to the **broker's own WhatsApp** so they no longer
have to sit in front of a web inbox. Typecheck ✅, lint ✅, all 61 existing AI unit tests ✅,
12 new unit tests ✅. Not yet applied to the live DB (migration + `notify_phone` config are
the user's next step — Supabase not authorized in this session).

---

## The end goal (why this exists at all)

We are building an **AI assistant for real-estate brokers (Dubai market) that lives inside
their WhatsApp workflow.** The one loop that matters:

> A lead messages the broker on WhatsApp → the AI reads the conversation, figures out what
> the lead wants (budget / area / requirement) → drafts a few human-worded reply options →
> the broker picks one and sends it.

The long-term vision layered on top of that same loop: reminders, follow-ups, lead
management, per-lead thread summaries, and deal-closing assistance. The AI does the reading,
remembering, and drafting; the **broker stays in control** — nothing is auto-sent, the human
always picks/edits before a message goes to a client.

**The specific goal of THIS session:** the suggestions were only visible on a localhost web
page (`inbox.html`). Brokers don't want to babysit a web page — they live in WhatsApp. So the
goal was: **get the AI's suggested replies onto the broker's own WhatsApp**, so they can copy
one and forward it to the lead, without opening any dashboard.

---

## The journey — how the request evolved (important context)

This session started on the wrong codebase and corrected course. Worth recording so the next
session doesn't repeat the confusion.

1. **First interpretation (standalone MVP):** The user has a prototype in `src/`
   (FourthspaceOS Stage-1: single-file SQLite, `inbox.html`, a mock/360dialog BSP). I first
   added a broker-notify hook there — after the 4 replies are generated in `handleInbound()`,
   fire-and-forget a WhatsApp card to an `AGENT_PHONE` env var. It worked (verified via
   `npm run simulate` with `BSP=mock`). **This is now considered throwaway** (see below).

2. **The WhatsApp constraint surfaced.** The user's real intent: *"the lead messages the
   broker directly, and the bot also reads it."* Key teaching moment —
   **WhatsApp does NOT let a third party read a private chat between two numbers.** The bot
   can only see a conversation if it is genuinely in the middle of it (i.e. the lead texts a
   number the bot/company controls). There is no "CC the bot" on a personal WhatsApp chat.

3. **The user's architecture (correct, and it sidesteps the constraint):** *every broker gets
   a company-provided number connected to 360dialog; all conversations are extracted to
   Supabase under the broker's/agent's id, holding their contacts and each contact's messages;
   the bot reads by agent id and pushes suggestions + updates + summaries per lead.* This is
   right because the messages legitimately flow through the company number → webhook →
   Supabase. "One company number per broker" isn't just convenient, it's the only lawful way
   the bot sees the messages.

4. **The big discovery:** that architecture **already exists** in this repo. The `wacrm/`
   folder (cloned + Supabase-wired in the 2026-07-21 wacrm-clone-setup session) is a full,
   mature WhatsApp CRM: multi-tenant **accounts** (= brokers), **contacts** (= leads),
   **conversations + messages** (in Supabase), a WhatsApp webhook that stores every inbound,
   AND an existing AI layer (`wacrm/src/lib/ai/*`). There was even a written plan,
   `Plans/lead-intelligence-ai-layer.md`, for exactly this feature.

5. **Decision (user-confirmed):** build the feature **in `wacrm/`, executing that existing
   plan**, plus the broker-WhatsApp-push addition. The `src/` SQLite MVP becomes a throwaway
   local sandbox. Storage: **fully Supabase** (it already is, in wacrm). Brokers:
   **one connected number = one broker today**, multi-broker is just data later.

**Answer to the user's recurring question — "do I need another number?": NO.** One connected
360dialog business number = one broker. To test end-to-end you need that number + a second
phone playing the lead + (optionally) the broker's personal number to receive the push. Only
ONE of those is a BSP/connected number.

---

## What we built (in `wacrm/`)

The feature is a **suggestions path** — distinct from wacrm's pre-existing auto-reply bot
(which auto-sends). This one never sends; it hands options to a human. It runs on every
plain-text inbound regardless of whether the auto-reply bot is on.

### 1. Migration — `wacrm/supabase/migrations/037_lead_intelligence.sql`
Additive `ADD COLUMN IF NOT EXISTS`, no new RLS (tables already `account_id`-scoped):
- `contacts.budget`, `contacts.area`, `contacts.requirement` (TEXT) — extracted qualification.
- `contacts.summary_upto` (TIMESTAMPTZ) — watermark: the newest message already folded into
  the rolling summary, so summarization stays incremental (flat token cost).
- `whatsapp_config.notify_phone` (TEXT) — broker's personal WhatsApp number for the push.
  NULL = broker notifications off.

### 2. AI lib files (reuse wacrm's `generateReply` + `buildSystemPrompt`; all best-effort, never throw)
- `wacrm/src/lib/ai/qualify.ts` — `qualifyLead(config, messages)` extracts
  budget/area/requirement via a JSON-only prompt (providers are text-only, no tool-calling —
  so we JSON.parse and tolerate stray fences). `mergeQualification(prior, incoming)` =
  **sticky fields**: `incoming.x ?? prior.x`, so a null (model didn't mention it this turn)
  never wipes a known value; a non-null correction overwrites. This is the MVP's
  `stickycheck` semantics done in JS.
- `wacrm/src/lib/ai/summarize.ts` — `summarizeConversation(config, newMessages, priorSummary)`
  folds only the post-watermark messages into the prior summary. `SUMMARIZE_AFTER_MESSAGES = 6`.
- `wacrm/src/lib/ai/suggest.ts` — `suggestReplies(config, messages, qualification)` returns
  **exactly 3** options (hard slice/pad, no re-prompt), grounded in the known fields.

### 3. Dispatcher + broker push — `wacrm/src/lib/ai/lead-intelligence.ts`
`dispatchLeadIntelligence({accountId, conversationId, contactId, configOwnerUserId})`:
1. Load AI config (`requireActive:false` — works even before the auto-reply master switch is on).
2. Build conversation context; bail if empty.
3. Read prior qualification + `summary_upto` off the contact.
4. **Qualify** → `mergeQualification` → UPDATE only the fields that changed to non-null
   (null-to-null keys omitted = the COALESCE, in JS).
5. **Summarize** once the thread ≥ 6 text messages: fetch only messages after the watermark,
   fold into the prior summary (read back from the latest `🤖 AI summary —` `contact_notes`
   row), INSERT a fresh dated summary note (with `account_id` + `user_id`), advance
   `summary_upto`.
6. **Suggest** 3 replies, then **push a card to the broker's WhatsApp** if
   `whatsapp_config.notify_phone` is set — using the low-level `sendTextMessage` primitive
   (phone_number_id + decrypted access_token) to an arbitrary number (the broker is not a
   stored contact). The card = lead's latest message + known fields + the 3 numbered options.
7. Whole body in try/catch; broker push has its own inner try/catch. **Never throws** into the
   webhook — mirrors the existing `dispatchInboundToAiReply` contract.

### 4. Webhook wiring — `wacrm/src/app/api/whatsapp/webhook/route.ts`
Calls `dispatchLeadIntelligence(...)` inside the existing `after()` block, right after the
auto-reply dispatch (~line 811), guarded by `!interactiveReplyId && inboundText.trim()`.

### 5. Suggestions endpoint — `wacrm/src/app/api/ai/suggest/route.ts`
Modeled exactly on `api/ai/draft/route.ts`: `requireRole('agent')`, reuses the `aiDraft` /
`aiDraftAccount` rate-limit keys, RLS account-ownership check on the conversation, loads the
contact's qualification to ground the call, returns `{ suggestions: string[] }` (length 3).
Read-only — sends nothing.

### 6. Inbox UI — `wacrm/src/components/inbox/message-composer.tsx`
A "suggest replies" button (MessageSquareDashed icon) beside the existing Sparkles draft
button → POSTs `/api/ai/suggest` → opens a Dialog listing the 3 options → clicking one fills
the composer (reusing `handleDraft`'s exact grow+focus pattern). No auto-send.

So the broker now receives suggestions **two ways**: in the wacrm web inbox (button) AND
pushed to their own WhatsApp (the card).

---

## Reuse (did NOT rebuild — verified all seams exist at the described shape before building)
- `generateReply({config, systemPrompt, messages})` → `{text, handoff, usage}` (raw text only) — `wacrm/src/lib/ai/generate.ts`
- `loadAiConfig`, `buildConversationContext`, `buildSystemPrompt`, `logAiUsage`, `supabaseAdmin()`
- `sendTextMessage` (arbitrary `to`) — `wacrm/src/lib/whatsapp/meta-api.ts`; `decrypt`, `sanitizePhoneForMeta`, `isValidE164`
- The `dispatchInboundToAiReply` auto-reply bot was the structural template for the dispatcher.
- `contact_notes` insert shape `{contact_id, account_id, user_id, note_text}` (account_id from migration 017).

---

## Verification run this session
- `npx tsc --noEmit` → clean.
- `npx eslint` on all changed files → 0 errors (removed one unused import; the one remaining
  warning, `downloadMedia` in the webhook route, is pre-existing, not ours).
- `npx vitest run src/lib/ai/` → **61 existing tests pass** (nothing broken).
- New `wacrm/src/lib/ai/lead-intelligence-core.test.ts` → **12 pass**: sticky-field merge
  (null doesn't wipe / correction overwrites / fills empty), JSON parse tolerance (clean /
  fenced / "null"-coercion / unparseable / provider error), and the exactly-3 slice/pad
  guarantee.

---

## Handed to the user (NOT done here — Supabase connector not authorized this session)
1. **Apply the migration:** `cd wacrm && supabase db push`. (Session log 2026-07-21 notes
   `db push` is gated by the auto-mode classifier and needs explicit permission.)
2. **Set the broker number:** put the broker's personal WhatsApp number (E.164, no `+`) into
   `whatsapp_config.notify_phone` for the account. NULL = push off; the inbox button still works.
3. **24h-window caveat:** the broker's personal number must have messaged the business number
   within WhatsApp's 24h free-text window, or the card send is blocked (same as any outbound).
4. **End-to-end test:** wacrm has no `simulate` like the MVP, and the webhook is HMAC-verified
   — either sign payloads with the account secret, or call `dispatchLeadIntelligence` directly
   with the service-role client in a thin harness. Then: inbound with a budget → `contacts.budget`
   populates; follow-up omitting it → unchanged (sticky); ≥6 messages → a `🤖 AI summary` note
   appears + `summary_upto` advances; click the inbox suggest button → 3 options → picking one
   fills the composer; with `notify_phone` set → the card lands on the broker's WhatsApp.

---

## Deliberately skipped (ponytail — add when needed)
- **Round-trip "reply 2 to send"** from the broker's WhatsApp — for now the broker copy-pastes
  a suggestion into their chat. Adding it means the webhook recognizing inbound FROM the broker
  number and routing a numeric pick to the lead (bigger change — webhook currently treats every
  inbound as a lead).
- Interactive WhatsApp buttons/list; notify throttling/mute; `facts[]` structured memory (one
  summary note covers it); re-prompt on bad JSON; embeddings/KB grounding in suggest.
- The `src/` SQLite MVP — left as a throwaway local sandbox, not the delivery target. (The
  earlier `AGENT_PHONE` hook there still works but is superseded by the wacrm build.)

## Files touched
**New:** `wacrm/supabase/migrations/037_lead_intelligence.sql`,
`wacrm/src/lib/ai/{qualify,summarize,suggest,lead-intelligence}.ts`,
`wacrm/src/lib/ai/lead-intelligence-core.test.ts`,
`wacrm/src/app/api/ai/suggest/route.ts`.
**Edited:** `wacrm/src/app/api/whatsapp/webhook/route.ts` (import + one call),
`wacrm/src/components/inbox/message-composer.tsx` (button + dialog + handlers).
**Earlier (throwaway MVP):** `src/webhook.ts`, `.env`, `.env.example` (the `AGENT_PHONE` hook).
