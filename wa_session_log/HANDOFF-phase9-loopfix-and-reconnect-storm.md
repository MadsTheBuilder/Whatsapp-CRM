# HANDOFF — Phase 9: self-loop fix (DONE) + Baileys reconnect storm (OPEN)

Date: 2026-07-22
Branch: master

## TL;DR

Two bugs were reported this session:
1. **Bot reading its own suggestion cards → infinite loop + "Mitko" cross-talk.** → **FIXED & verified live.**
2. **No suggestion card after approving a lead.** → **root cause NOT yet confirmed**, because the
   test got blocked by a **Baileys reconnect storm** (229 disconnects vs 4 connects) that prevented
   the test message from ever reaching the brain. This is the open item to resume on.

Server is currently **stopped** (port 3000 free). Nothing running.

---

## Bug 1 — self-loop / Mitko cross-talk — FIXED

### Root cause
The bot DMs the agent via 360dialog from its own number **971581137568**. The agent's phone is
what Baileys reads. So Baileys read the bot's own "New message… Suggested replies…" cards back in as
if they were inbound lead messages, qualified them, and DM'd another card → infinite loop (each card
nesting the previous), and replies referenced whatever lived in that self-chat's memory ("Mitko").

### Fix (committed to working tree, not yet git-committed)
Single guard at the pipe seam so 360dialog inherits it too:
- `src/pipe/baileys.ts` — added `COMPANY_BOT_NUMBER` env read; in `toEvent()`, drop any 1:1 chat
  whose counterpart equals `COMPANY_BOT_NUMBER` (return null before the brain ever sees it).
- `.env` / `.env.example` — added `COMPANY_BOT_NUMBER=971581137568` (confirmed by user as the bot number).
- `scripts/baileyparse.test.ts` — sets `COMPANY_BOT_NUMBER` before import + asserts the bot's own
  chat drops. `npm run test:logic` passes; `npm run typecheck` clean.

### Verified live
Nina (a real inbound) produced one card, and the bot's outbound card (from 971581137568) did **not**
reappear as an inbound — no `[baileys] in from 971581137568` in the log. Loop is dead.

---

## Data-state facts established this session (Supabase)

- **Nina** `33781692289` → lead row `monitor: "rejected"`. Confirmed she is permanently ignored:
  gate at `src/brain.ts` `if (lead.monitor !== "approved") return` fires before any store/LLM. Her
  messages are **never stored** (saveMessage sits after the gate). Footprint = the one leads row only.
- **Madhur** `919717662666` → was lead 11 (approved, 0 msgs/0 memory) → **deleted** on request →
  re-approved fresh as **lead 13** (`agent_demo`, approved, 0 messages).
- The old message table still holds 26 rows under **dead lead ids 1/3/4** — these include the old
  loop's residue: bot cards ("New message from Madhur… Suggested replies…") stored AS lead messages,
  and the "Mitko contact" texts. That's the historical Mitko source. Not cleaned up yet (harmless —
  orphaned under deleted leads — but worth wiping when convenient).

---

## Bug 2 — "no card after approval" — OPEN, root cause unconfirmed

### What we know
- Madhur approved (lead 13, monitor=approved) but **0 messages stored** and **no card**, with
  **no error logged**. Log showed exactly one `[baileys] in from 919717662666 … handing to brain`
  and then silence.
- Ruled OUT: store layer (a manual `saveMessage` on lead 13 returned true + persisted), Ollama down
  (`llama3.1:8b` responds on :11434), the approval itself (flag did flip to approved), and
  direction=="out" (log printed "in").
- Leading hypothesis: the **in-process `seenWaIds` dedup set** in `src/pipe/baileys.ts` burned the
  message's waId on a pre-approval delivery, so the post-approval delivery was skipped before the
  brain. (The design also intentionally DROPS the approval-triggering message — the lead must send a
  NEW message after approval to get the first card. That's expected, not a bug.)

### Diagnostics ALREADY ADDED (in working tree)
`src/brain.ts` now logs at each early return so the next run is not a black box:
- `[brain] drop <num>: monitor=<x> (not approved)`
- `[brain] drop <num>: duplicate waId=<id>`
- `[brain] stored out-msg … no card (agent's own reply)`
- `[brain] <num> approved+saved — generating card...`
These are marked `// ponytail: diag` — remove once Bug 2 is closed.

### Why we couldn't finish the test → the REAL blocker
When the user sent the test message, it never appeared. The Baileys socket was in a **reconnect
storm**: `grep -c "connection closed" = 229` vs `"connected" = 4`. No `logged out` / status code was
logged (the close handler at `src/pipe/baileys.ts` ~L126-137 throws away the statusCode for
non-logout closes — **we are blind to the reason**). Only one logical server process was running
(tsx parent + worker), so it was NOT dueling processes.

Most likely cause (per CLAUDE.md rule): the **same WhatsApp number is active elsewhere** — WhatsApp
Web open in a browser, or the phone's WhatsApp actively in use — knocking Baileys offline. 229 flaps
with no logout code is that signature.

---

## RESUME HERE — next steps

1. **Stop anything else using the Baileys number.** Close WhatsApp Web on that number; don't actively
   use the phone's WhatsApp while Baileys runs. (CLAUDE.md: they knock each other offline.)
2. **Make the disconnect reason visible** (small, worth doing): in `src/pipe/baileys.ts` the
   `connection === "close"` branch, log the `statusCode` on the non-logout path too, e.g.
   `console.warn("[baileys] closed code=", code, " reconnecting...")`. Right now we can't see why it
   drops. Consider a small backoff before the reconnect call so a storm can't hammer.
3. **Restart clean:** `npm start` (server logs went to the scratchpad log this session; use a project
   path if you want them kept). Wait for a single stable `[baileys] connected` with NO closes
   following before testing.
4. **Run the controlled test:** with Madhur already approved (lead 13), have him send ONE brand-new
   message (fresh text = fresh waId). Watch for the `[brain]` line:
   - `approved+saved — generating card...` → working; a card should follow.
   - `drop … duplicate waId` → confirms the seenWaIds hypothesis (fix: don't add to seenWaIds until
     AFTER the brain accepts it, OR skip dedup for messages that were previously gated/dropped).
   - `drop … monitor=` → unexpected; re-check the leads row.
5. Once Bug 2 is closed, **remove the `// ponytail: diag` lines** in `src/brain.ts` and the
   `[baileys:diag]` / `[company:diag]` lines if inbound is trusted.
6. **Optional cleanup:** wipe the 26 orphaned message rows under dead leads 1/3/4.

## Files touched this session (working tree — NOT git-committed)
- `src/pipe/baileys.ts`  — COMPANY_BOT_NUMBER guard (fix) + it still lacks statusCode logging (todo #2)
- `src/brain.ts`         — 4 `[brain]` diag log lines (temporary)
- `.env`, `.env.example` — COMPANY_BOT_NUMBER
- `scripts/baileyparse.test.ts` — bot-number-drop assertion

## Env / infra notes
- Bot's own number: **971581137568** (`COMPANY_BOT_NUMBER`).
- Agent's phone (where cards land): **971581871500** (`AGENT_COMPANY_NUMBER`).
- LLM: local Ollama `llama3.1:8b` at http://localhost:11434/v1 (`.env`).
- Supabase live; junk from old builds still present (dead leads 1/3/4).
- 360dialog webhook needs a public tunnel to receive approval taps at /company-webhook on :3000.
