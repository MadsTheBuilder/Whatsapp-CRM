# Session Handoff — FourthspaceOS WhatsApp Assistant (Phase 8: approval flow LIVE-VERIFIED + 2 bugs fixed)

**Date:** 2026-07-22
**Branch:** master
**Source of truth:** `CLAUDE.md`
**Prior handoff:** `HANDOFF-phase7-approval-flow.md` (gate built + committed, but never tested live).

---

## Headline

The **lead approval gate is now proven end-to-end on real WhatsApp.** Unknown number → gated →
Yes/No prompt → tap Yes → `monitor='approved'` → suggestion card. All confirmed live with the test
number `+919717662666`. Two real bugs were found and fixed getting there (see below).

**Uncommitted work this session** — code fixes are in the working tree, NOT yet committed:
- `src/pipe/baileys.ts` — @lid duplicate-lead fix + diag logs.
- `src/company.ts` — one diag log line.
- `scripts/baileyparse.test.ts` — updated assertion for the @lid drop.
Commit these before anything else next session (see "Commit first" below).

---

## Bugs found & fixed this session

### Bug 1 — @lid messages spawned garbage duplicate leads  (FIXED, needs commit)
A WhatsApp `@lid` (privacy linked-id) message carries the real phone on `key.senderPn`. When
`senderPn` was **absent**, the old code fell back to the opaque lid digits and stored them **as if
they were a phone number** — creating a second, junk lead (e.g. `260086173855767`, `216415432929328`)
alongside the real one. Symptom seen live: **two Yes/No prompts** for one contact — one for the real
`+919717662666`, one for a phantom `Madhur Gupta (+260086173855767)`.

Root cause: `jidToNumber(senderPn ?? jid)` at [src/pipe/baileys.ts](src/pipe/baileys.ts). This
Baileys version (`@whiskeysockets/baileys`) has **no lid→phone lookup API** (checked — no
`LIDMapping`/`getPNForLID`), so a lid without `senderPn` has no usable phone.

**Fix:** drop the message entirely when it's `@lid` and `senderPn` is missing (`if (isLid && !senderPn)
return null`). WhatsApp reliably includes `senderPn` on the **first** message from a new contact —
which is the one the gate needs — so the real lead is never lost; only the redundant no-phone
re-deliveries are dropped. Offline test `scripts/baileyparse.test.ts` updated to assert the drop
(was asserting the old wrong fallback). `npm run typecheck` + parse test both pass.

### Bug 2 — 360dialog webhook pointed at the WRONG PATH  (FIXED live via API — but see gotcha)
Tapping Yes did nothing — the row stayed `pending`, no confirmation. Cause: **360dialog's registered
webhook URL was `…/webhook`, but the server serves `/company-webhook`.** Taps were delivered to the
tunnel, hit a non-existent path, 404'd, and vanished. No code bug — pure config.

**Fix applied live** by POSTing the correct URL to `https://waba-v2.360dialog.io/configs/webhook`
with the `DIALOG360_API_KEY` from `.env`. Verified it took. After the fix, tap Yes → confirmation DM
→ suggestion card, all working.

**Check/set the 360dialog webhook via API (no dashboard needed):**
```
# GET current:
GET  https://waba-v2.360dialog.io/configs/webhook   header: D360-API-KEY: <key>
# SET:
POST https://waba-v2.360dialog.io/configs/webhook   header: D360-API-KEY: <key>
     body: {"url":"<NGROK_URL>/company-webhook"}
```

---

## ⚠️ CARRY-FORWARD GOTCHA — ngrok URL changes break approvals every restart

The webhook fix is **not permanent.** ngrok (free plan) hands out a **new public URL on every
restart**, but the 360dialog webhook stays pinned to the OLD url → taps silently 404 again.

**Every session that restarts ngrok MUST re-point the 360dialog webhook:**
1. Get the live tunnel: `curl -s http://localhost:4040/api/tunnels` → read `public_url`.
   (This session it was `https://pogo-unharmed-stopping.ngrok-free.dev`.)
2. POST `<that url>/company-webhook` to `https://waba-v2.360dialog.io/configs/webhook` (see API above).
3. Sanity check the tunnel reaches the server:
   `curl -X POST <ngrok>/company-webhook -d '{"test":"ping"}'` → server should log `[company:diag] POST hit`.

Real fix (do later): a **paid ngrok static domain** or a **Cloudflare tunnel** with a fixed hostname,
set once in 360dialog and never touched again. Until then, this is a per-restart chore.

---

## Diag logs still in the tree (REMOVE before committing "clean")

Added this session for debugging, still present:
- `src/pipe/baileys.ts` — `[baileys:diag]` on `sock.ev.process` (every event) AND in `messages.upsert`
  (raw upsert type/count/jids).
- `src/company.ts` — `[company:diag] POST hit; body=...` at the top of the POST handler.

They're noisy but harmless. They did their job (proved inbound works, proved taps were 404ing).
**User had NOT yet decided** whether to strip them — the "remove diag logs" prompt was interrupted.
Ask, then either strip all three and commit clean, or commit with a `ponytail:` note and strip later.

---

## Test status vs. HANDOFF-phase7 test script

| Section | Status |
|---|---|
| **1. Approval flow** | ✅ **DONE, live-verified.** pending row + message dropped + single prompt (dup fixed) + tap Yes → approved + confirmation DM + suggestion card. **Rejection path (tap No) NOT yet tested** — do it next. Q&A-alongside-approval NOT re-tested. |
| **2. Latency re-measure** | ❌ **NOT done.** Model is `llama3.1:8b` (no swap persisted; `.env` + `ollama list` agree). Warmed to **100% GPU** this session. Baseline to beat: ~2,967ms. Still need a real send→card timing. |
| **3. Memory + summary** | ❌ **NOT done.** Needs an approved lead + 7+ inbound turns (crosses `SUMMARIZE_AFTER=6`). `919717662666` is now approved (`id=11`) — good candidate, but note its budget/area/requirement are still null and no messages stored yet. |
| **4. Optional** | duplicate-card verify + external Q&A via ngrok — not done. |

---

## DB state (live Supabase) as of end of session

Approved leads: `971500000001` (Demo Lead), `971581137568`, `971582941441` (Dennis Kobe),
**`919717662666` (Madhur) — id=11, monitor=approved** (the test number, freshly approved).
All the junk @lid rows (`260086173855767`, `216415432929328`) were **deleted** this session.

Note: `919717662666` id=11 has `budget/area/requirement = null` and **no messages row** — the
approving message wasn't stored under it. Harmless; fills in as chatting continues. If you want a
clean memory test, either keep chatting or delete+re-approve.

---

## ===== NEXT SESSION order =====

1. **Commit first.** The @lid fix + test update are real and proven — commit them (decide on diag
   logs first: strip or keep with `ponytail:` note). Suggested message:
   "Fix @lid duplicate leads + correct 360dialog webhook path (approval flow live-verified)".
   (The webhook path fix is config-side, not in the repo — mention it in the commit body only.)
2. **Re-point ngrok webhook** if ngrok was restarted (see the CARRY-FORWARD GOTCHA — this WILL bite).
3. **Finish Test 1:** rejection path (fresh number → tap No → `monitor='rejected'` → further messages
   produce nothing) + Q&A-alongside-approval ("how many leads?").
4. **Test 2 latency** and **Test 3 memory/summary** (both untouched — full script in phase-7 handoff §2/§3).

---

## Gotchas (carry-forward — still all true, plus new)

- **NEW: 360dialog webhook path is `/company-webhook`, not `/webhook`.** And it must be re-pointed at
  the new ngrok URL after every ngrok restart or taps 404 silently. (biggest new trap.)
- **NEW: @lid without senderPn is dropped** — by design now. If a legit lead ever seems "invisible",
  check they're sending a first message with `senderPn` (they normally do). Don't "fix" this by
  re-adding the lid fallback — that reintroduces the duplicate-lead bug.
- **Baileys "connected" but no inbound right after start** — the socket needs a few seconds to
  subscribe. Seen this session: first texts after `[baileys] connected` sometimes don't fire upsert
  until the socket settles. Wait, retry.
- **WhatsApp reply buttons are one-shot** — once tapped they grey out and can't be re-tapped. To
  re-test approval, DELETE the lead row (forces a fresh prompt with fresh buttons). Flipping an
  existing row to `pending` does NOT re-prompt (the prompt only fires on row *creation*, brain.ts:60).
- **Ollama stale-process trap** — `ollama ps` vram=0 ⇒ kill all ollama + `ollama serve`. Warm before
  measuring latency. This session: warmed to 100% GPU, `llama3.1:8b`.
- **Don't open WhatsApp Web on the agent's number** while Baileys runs.
- **Don't run `supabase/schema.sql` on live DB** — it drops tables. Migration `001_add_monitor.sql` is
  the safe path and is already applied.
- **24h window** — text the company number first so approval buttons deliver free-form (no template).
- **`baileys_auth/` gitignored** — live session keys, never commit.

---

## Repo shape (unchanged from phase-7)

```
src/  server.ts brain.ts notify.ts qa.ts company.ts reminders.ts store.ts
      qualify.ts replies.ts memory.ts claude.ts listings.ts
      pipe/{types.ts, baileys.ts}  types/qrcode-terminal.d.ts
scripts/  simulate.ts memcheck.ts respcheck.ts stickycheck.ts
          storelogic/baileyparse/qalogic/reminderlogic/approvallogic.test.ts  (offline, test:logic)
supabase/  schema.sql  migrations/001_add_monitor.sql
```
