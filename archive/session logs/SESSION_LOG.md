# Session Log — FourthspaceOS Stage-1 WhatsApp MVP

Newest first. Each entry = what changed, why, and any state the next session needs.

---

## 2026-07-20 — PropertyFinder listings wired into reply generation, two bugs fixed live

**Outcome:** New feature — once a lead is fully qualified (budget/area/requirement all
known), the pipeline auto-searches PropertyFinder and weaves 1-2 real listings into the
4 AI-suggested replies. Built, then debugged live against Madhur Gupta's real WhatsApp
number end-to-end. Two real bugs found and fixed; one still open.

**Design (user-chosen via AskUserQuestion):**
- New `src/listings.ts` module (not inline in webhook.ts).
- Listings feed into the existing `suggestReplies()` prompt — no separate UI panel.
- Search fires **once**, only on the turn a lead first becomes fully qualified — not
  re-queried on every later message in an already-qualified thread.

**New file — `src/listings.ts`:** `findMatchingListings(q, limit=3)` — resolves
`q.area` via `GET /locations?query=`, parses `q.budget` ("80k", "2M AED", etc.) into
`max_price`, parses `q.requirement` (format `"buy · off-plan apartment · 2BR"` from
`joinRequirement` in qualify.ts) into `category` + `min_beds`, then calls
`GET /search`. Returns `[]` on any failure — a missing match set must never break
reply generation. PropertyFinder REST API is local: `http://localhost:8642`
(`propertyfinder-api/src/pf_api/rest.py`, FastAPI). The MCP server in `.mcp.json` is
just a thin wrapper over this same REST API for Claude Code's own tool access — the
app itself calls the REST API directly via `fetch`, not through MCP.

**Wired into `src/webhook.ts` (`handleInbound`):** after `qualify()`, before
`suggestReplies()` — search runs conditionally, result passed as 5th arg to
`suggestReplies()`. **Wired into `src/replies.ts`:** new `listingsBlock()` helper
formats matches into the prompt; system prompt tells the model to weave in 1-2
naturally, never dump a raw list or invent details beyond what's given.

**Bug #1 (fixed) — stale server process.** First live test showed vague, non-listing
replies despite correct qualification. Root cause: the *running* `tsx watch` dev
server predated creation of `listings.ts` by over an hour (started before this
session's edits existed) — Git-Bash `ps aux` PIDs don't map to real Windows PIDs, so
finding the actual process required
`Get-NetTCPConnection -LocalPort 3000 -State Listen | ... | Get-CimInstance Win32_Process`
in PowerShell, then `Stop-Process -Force`. **Lesson: after editing source, confirm the
dev server actually reloaded — tsx watch usually does, but verify if output looks stale.**

**Bug #2 (fixed) — listings search never fired for a lead that qualifies on message 1.**
The trigger condition was `lead.next_question !== null && q.next_question === null`
(prior state non-null → this turn null = "just became qualified"). But a brand-new
lead's `next_question` column defaults to `NULL` in the schema — same value as "already
qualified". So a lead giving budget+area+requirement all in their very first message
(no prior "unqualified" state to transition from) silently skipped the search every
time. **Fix in `webhook.ts`:** replaced the check with
`wasQualified = lead.budget !== null && lead.area !== null && lead.requirement !== null`,
trigger fires when `!wasQualified && q.next_question === null`. This correctly
distinguishes "never qualified before" from "already qualified, don't re-search."

**Bug #3 (fixed) — bedroom-count regex missed bare digits.** `qualify.ts`'s
`joinRequirement` sometimes emits just `"1"` for bedrooms (no "BR"/"bed" suffix), e.g.
`"rent · apartment · 1"`. Old regex `/(\d+)\s*(?:bed|beds|br)\b/i` required that
suffix, so `min_beds` silently became `null` (verified: real API call for JVC/rent/80k
without min_beds returned a studio in the results, wrong for a stated 1-bed request).
**Fix in `listings.ts` `parseRequirement()`:** since `joinRequirement`'s format is
always `·`-separated with bed count last, now takes `requirement.split("·").pop()`
and matches `/(\d+)/` on just that segment — robust to bare digits, doesn't rely on a
suffix, and can't accidentally grab digits from an earlier segment (e.g. a price).

**Verified against the real API (not mocked):** `GET /locations?query=JVC` → resolves
to location id 73. `GET /search?location=73&category=rent&min_beds=1&max_price=80000`
→ 3 real listings (real prices, buildings, share_urls). Confirmed via a throwaway
script (`scripts/_tmp_test_listings.ts`, deleted after use — don't leave temp test
files in `scripts/`).

**Standing instruction from user (still in effect):** `.env` has `BSP=meta` — clicking
Send in the inbox fires a REAL Meta WhatsApp Graph API send. User explicitly chose to
leave this as-is and test carefully themselves rather than switching to `BSP=mock`. Do
not change `BSP` without being asked again.

**State at end of session:** Madhur Gupta's lead (phone `971581871500`) was wiped from
`fourthspace.db` **twice** during debugging (most recently: lead id 14 deleted — messages,
memory, lead row) to get a clean first-message qualification test after each fix. As of
this log, his lead does not exist in the DB — his next inbound message creates a brand
new lead and should be the first real end-to-end test of both fixes together.

**Not yet committed:** `src/listings.ts` (new), `src/webhook.ts`, `src/replies.ts`
changes, this log entry. Nothing pushed.

**Pending / next session should:**
1. Confirm the user actually re-sent a message from Madhur's number after the last DB
   wipe, and check `/api/threads` (or the inbox UI) for: qualification fields
   populated correctly, and — the actual point of this session's work — whether the 4
   suggested replies now reference specific real listing details (price/building/area),
   not generic discovery questions. If they still don't, the bug is downstream of
   `findMatchingListings()` (which is now confirmed working) — check `suggestReplies()`
   prompt assembly / whether `listings` is actually non-empty at call time in
   `webhook.ts`, add a temporary `console.log(listings.length)` if needed.
2. Known unaddressed gap (not yet requested by user, don't fix without asking):
   `/api/send` has zero staleness/ordering protection — clicking a cached reply option
   in the inbox before the webhook finishes processing the latest inbound can send a
   stale reply. Observed once during this session (a stale reply went out as a real
   message). Not investigated further since out of scope until the user raises it.
3. Once the fixes are confirmed working live, this is a good point to commit
   `listings.ts` + the webhook/replies changes (ask user first, per repo convention —
   only commit when explicitly asked).

---

## 2026-07-18 — Live WhatsApp loop proven + LLM moved to local Ollama

**Outcome:** Full inbound→qualify→draft→send loop verified live with real WhatsApp
messages. Rate-limit problem eliminated by moving the LLM local.

**Cleared both HANDOFF blockers:**
- `META_PHONE_NUMBER_ID` fixed → `400691083134462` (was the raw phone number).
- Webhook exposed via ngrok → `https://pogo-unharmed-stopping.ngrok-free.dev/webhook`
  (free URL; changes if ngrok restarts). Verify token `fourthspace-verify`. Handshake passes.

**META_TOKEN rotated** — user pasted a fresh temporary token (old one expired, 401/code 190).
Temporary tokens die ~daily; permanent System User token still TODO before demo.

**LLM: OpenRouter free tier → local Ollama.** Free models were unusable — constant
429s, Google endpoint blocked by an account privacy toggle, and NVIDIA/nemotron models
ignore forced `tool_choice`. Switched to local `llama3.1:8b` via Ollama (installed,
15.7GB RAM box, no rate limits, offline).
- `src/claude.ts` now branches: Ollama path hits `/api/chat` with `format: <schema>`
  (native structured output — reliable) instead of OpenAI `tool_choice` (which Ollama
  ignores). OpenRouter tool-call path kept for when `LLM_BASE_URL` points back at it.
- `.env`: added `LLM_BASE_URL=http://localhost:11434/v1`, `MODEL=llama3.1:8b`.
- Flip back to OpenRouter anytime via `.env` only (no code change).

**Meta receive dropped mid-session, fixed over Graph API.** After a server restart,
Meta stopped forwarding inbound (send still worked → 2-tick delivered but no webhook POST).
Cause: app unsubscribed from the WABA. Re-subscribed via
`POST graph.facebook.com/v21.0/436973069494444/subscribed_apps` → `{"success":true}`.
Confirmed phone-number webhook override points at the live ngrok URL. WABA ID: `436973069494444`.
**If receive stops again: re-run that subscribed_apps POST.**

**"No auto-message sent" = by design, not a bug.** System is human-in-the-loop: AI drafts
4 replies, agent clicks Send in the inbox. User confirmed they want to KEEP this behavior.

**Cleanup:** killed 7 orphaned `tsx watch` server processes from repeated restarts;
one clean server now runs on port 3000 writing to `server.log`.

**Verified:** `/api/threads` shows real lead "Madhur Gupta" (971581871500), stage `deep`,
budget `around 1.4M`, area `JVC`, requirement missing → auto next-question generated,
4 human-toned replies cached. Inbox UI renders it all.

**Not yet committed:** `claude.ts` + `.env` Ollama changes, this log, HANDOFF deltas.

**Watch-outs for next session:**
- Keep the Ollama server process alive (LLM calls fail if it stops). First call after
  idle is slow (~10-30s model reload), then fast.
- ngrok free URL changes on restart → re-register in Meta + re-run the send tests.
- Temporary META_TOKEN expires ~daily → get a permanent System User token before demoing to Kunal.
