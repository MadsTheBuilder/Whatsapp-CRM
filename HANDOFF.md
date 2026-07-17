# Session Handoff — FourthspaceOS Stage-1 WhatsApp MVP

_Last updated: end of build/run session (2026-07-18). Read this first in a fresh session._

## TL;DR

A lean, **runnable** WhatsApp lead-response MVP is built and working on
`localhost:3000`. The full loop is proven: inbound WhatsApp message → AI
qualification (budget/area/requirement) → 4 human-toned reply options → agent
picks → send. It's committed to git. **The only thing left before real
end-to-end WhatsApp works is (1) a correct Meta Phone Number ID and (2) ngrok
to expose the webhook.**

Project root: `c:\Users\madhu\Claude Code\Kunal Context\fourthspace-mvp`

## What works right now (verified live this session)

- ✅ `npm run typecheck` — clean
- ✅ `npm run check` — full end-to-end self-check passes (real extraction + 4 replies)
- ✅ Server boots on `http://localhost:3000/inbox.html`
- ✅ Inbox UI renders threads, extracted fields, missing-field flags, 4 AI replies
- ✅ Meta-shaped webhook `POST /webhook` parses → stores lead+message → qualifies → caches 4 replies
- ✅ Webhook `GET /webhook` verify handshake (echoes challenge on matching token, 403 otherwise)
- ✅ A test lead ("Ahmed", 1BR Dubai Marina rent ~90k/yr) was injected and showed up fully qualified in the inbox

## Key architecture decisions made this session (deviations from the original plan)

These were forced by the local environment and are **intentional** — don't revert without reason:

1. **`better-sqlite3` → `node:sqlite`** (`src/store.ts`). The native module needs
   Visual Studio to compile, which isn't installed on this Windows box. Node 24's
   built-in SQLite has the same synchronous API. This *removed* a dependency.

2. **Anthropic SDK → OpenRouter via OpenAI SDK** (`src/claude.ts`). User has **no
   Anthropic API key**; we're using OpenRouter **free** models for testing.
   - `claude.ts` now uses the `openai` package pointed at `https://openrouter.ai/api/v1`.
   - Structured extraction uses **forced `tool_choice`** (OpenAI function-calling shape).
   - `qualify.ts` / `replies.ts` were **NOT changed** — they still call `structured()`
     and import the Anthropic `InputSchema` **type only** (no runtime Anthropic dep).
   - **Free models rate-limit constantly (429/402).** So `structured()` tries a
     **fallback chain** of known-working free models until one answers:
     `google/gemma-4-31b-it:free` → `nvidia/nemotron-3-super-120b-a12b:free` →
     `nvidia/nemotron-3-nano-30b-a3b:free` → `meta-llama/llama-3.3-70b-instruct:free`
     → `qwen/qwen3-next-80b-a3b-instruct:free`.
   - To make a single model reliable, the user can add their own OpenRouter credits.
   - **To switch back to real Claude later:** change `baseURL`, `apiKey` env, and
     `MODEL` in `claude.ts` back to Anthropic (marked with a `ponytail:` comment).

## `.env` state (file exists, gitignored)

| Key | Status |
|---|---|
| `OPENROUTER_API_KEY` | ✅ set by user (working) |
| `MODEL` | `google/gemma-4-31b-it:free` (first in fallback chain) |
| `BSP` | `meta` (real WhatsApp send path selected) |
| `AGENT_ID` | `agent_demo` |
| `VERIFY_TOKEN` | `fourthspace-verify` (paste this same string into Meta webhook config) |
| `PORT` | `3000` |
| `META_TOKEN` | ✅ set by user — **⚠️ was pasted in chat, user should ROTATE it in Meta dashboard before production** |
| `META_PHONE_NUMBER_ID` | ❌ **WRONG** — currently holds the phone number `+971 58 187 1500`. Must be the numeric **Phone Number ID** from Meta → WhatsApp → API Setup (a long ID, no `+`, no spaces). Outbound send will 404 until fixed. |

## The two blockers for real end-to-end WhatsApp

1. **Fix `META_PHONE_NUMBER_ID`** — get the numeric Phone Number ID from
   Meta dashboard → WhatsApp → API Setup (it's labeled "Phone number ID", shown
   under the test number). Replace the phone number currently in `.env` line 20.
   Only the outbound *send* needs this; everything else already works.

2. **Expose the webhook with ngrok** — Meta can't reach `localhost`. Run
   `ngrok http 3000`, then in the Meta dashboard (WhatsApp → Configuration →
   Webhook) register `https://<ngrok-url>/webhook` with verify token
   `fourthspace-verify`, and subscribe to the `messages` field.
   - **ngrok is not yet confirmed installed** — check `ngrok version` first;
     may need to install + add an authtoken.

## Credentials the user HAS but this app does NOT use (Stage 2/3)

App ID, App Secret, WhatsApp Business Account ID. The Stage-1 send path only
needs `META_PHONE_NUMBER_ID` + `META_TOKEN`.

## How to resume

```bash
cd "c:/Users/madhu/Claude Code/Kunal Context/fourthspace-mvp"
# server may still be running from last session on port 3000; if not:
npm run dev            # or: npx tsx src/server.ts
# open http://localhost:3000/inbox.html
```

To inject a test lead without WhatsApp (no phone needed):
```bash
npm run simulate -- "Looking for a 2BR in JVC, budget around 1.4M"
```

## Suggested next steps (user's choice at handoff)

- **A)** Fix Phone Number ID + set up ngrok → message the test number from a real
  phone and get a live reply. (This was the direction the user was heading.)
- **B)** Keep exploring the inbox on localhost with simulated leads.

## Git state

- Repo initialized in the MVP folder (workspace root is not a git repo).
- Branch: `master`
- Commits:
  - `e0dde38` — initial MVP
  - `579217c` — OpenRouter free-model routing with fallback chain (latest)
- Working tree clean at handoff. `node_modules`, `.env`, `*.db`, `server.log` gitignored.

## Files map

```
fourthspace-mvp/
  src/
    server.ts        express: webhook + /api/threads + /api/send + serves web/
    webhook.ts       Meta Cloud API GET verify + POST receive; handleInbound() loop
    claude.ts        OpenRouter (OpenAI SDK) structured() with free-model fallback chain
    qualify.ts       extract budget/area/requirement + next question
    replies.ts       4 stage-aware human-toned reply options
    store.ts         node:sqlite; leads + messages; agent_id on every row
    bsp/
      index.ts       BSP interface + makeBSP() factory (env-selected)
      mock.ts        MockBSP — logs the send, no number needed
      meta.ts        MetaCloudBSP — real Graph API send
    web/
      inbox.html     minimal vanilla agent inbox
      inbox.js       fetch threads, render, POST /api/send
  scripts/simulate.ts  inject fake inbound + `npm run check` self-check
  .env               (gitignored; see table above)
  README.md          run steps + Meta test-number wiring
  HANDOFF.md         this file
```

## Watch-outs for the next session

- Free OpenRouter models drift in/out of rate limits minute-to-minute. If ALL
  chain models 429 at once, the webhook logs "all models failed" and acks 200
  (Meta won't retry-storm). Wait a bit or add OpenRouter credits.
- `node:sqlite` prints an experimental-feature warning on every run — harmless.
- The server holds the SQLite WAL file open; on Windows you must kill the tsx
  process (not just Ctrl-C a backgrounded one) before deleting `fourthspace.db`.
- The plan file this was built from: `C:\Users\madhu\.claude\plans\i-need-a-features-crispy-snowglobe.md`
```
