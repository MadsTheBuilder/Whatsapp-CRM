# HANDOFF phase15b — Baileys lane LIVE-VERIFIED + registry number fix

Date: 2026-07-25
Branch: `master` (main branch is `main`)
Status: **Baileys read-lane verified live end-to-end. Phase 15 still UNCOMMITTED. dialog360 read-lane still unverified.**

Continues from `HANDOFF-phase15-multi-agent-lane-routing.md`.

---

## TL;DR of this session

Picked up Phase 15's leftover work (live end-to-end verification). Found and fixed a real
silent-failure bug in the seeded registry, then verified the Baileys lane end-to-end: a real
lead message read on the dev number produced a suggestion card on the agent's number.

**The one thing that mattered most:** the `you` registry row had a typo'd `read_number`
(`97581871500`, 11 digits) that would have dropped every message silently. It's now fixed to
`971581871500`. This was the exact ⚠️ the prior handoff flagged as unverified.

---

## What got done (in order)

1. **Confirmed the Baileys own-number.** Read `baileys_auth/creds.json` → `me.id =
   "971581871500:32@s.whatsapp.net"`. `jidToNumber` strips to `971581871500`. This is the
   number the QR is scanned with. (Resolved the prior handoff's ⚠️.)

2. **Found the registry typo (the real bug).** `scripts/regcheck.ts` (new, throwaway) called
   `resolveAgentByReadNumber("971581871500")` → **NULL**. The seeded `you` row held
   `read_number/send_number = "97581871500"` (11 digits — the original typo from the prior
   session, NOT the inferred 12-digit value the handoff assumed). Every inbound message would
   have been silently dropped.

3. **Fixed the row.** `scripts/regcheck.ts` now updates `agents` set
   `read_number=send_number='971581871500' where agent_id='you'`. Re-ran → resolver returns
   `you send=971581871500 ✅`. Mitko's row was already correct (`971523398688`).

4. **Flipped the pipe to Baileys.** `.env` was `AGENT_PIPE=dialog360` (Mitko's lane); changed
   to `AGENT_PIPE=baileys` so the dev number reads. Added a comment line noting the dev number.

5. **Booted the server, hit environment issues, worked through them:**
   - A stale server from earlier in the session (PID on :3000, booted with the OLD
     `AGENT_PIPE=dialog360`) had to be killed — `EADDRINUSE`. Killed it, restarted on baileys.
   - Confirmed Ollama up (`llama3.1:8b`, the configured MODEL) so the brain can generate cards.

6. **Diagnosed and fixed the "no card" symptom.** THIS WAS THE BULK OF THE SESSION. Chain:
   - Server booted, `[baileys] connected`, `[baileys] agent lane: you (read ... → send ...)`.
   - But test messages produced **zero `messages.upsert` events** — the raw diag line that
     fires before any filter never appeared. So the message never reached the socket at all.
   - Saw `connection closed code=428` ("connection replaced") flapping → WhatsApp Web was open
     on the same number (the CLAUDE.md warning). User logged out linked devices.
   - Still zero messages after that. The socket connected but received ONLY
     `call` / `group-participants.update` / `creds.update` — **never any `messages`-family
     event, never even receipts.** A socket that authenticates but gets no message stream =
     **stale/desynced Baileys credentials (a "zombie link").** Auth succeeds, so auto-reconnect
     keeps "succeeding" into a deaf socket; it's not a logout (no 401) so it never re-scans.
   - **Fix: wiped `baileys_auth/` (backed up to `baileys_auth.bak`) + fresh QR scan.** User
     re-linked with `971581871500`. Fresh link completed the initial sync → live message stream
     restored.

7. **VERIFIED LIVE ✅** — user sent a real lead message from another phone → `971581871500`;
   a suggestion card was generated on the agent's number. Message → resolved to `you` lane
   (registry, not env) → card to the correct `send_number`. The core loop works end-to-end
   through Baileys.

---

## Root-cause notes (so the next session doesn't re-chase this)

- **Why it broke: the Baileys saved login rotted, NOT the Phase 15 code.** Phase 15 only
  touched routing (which agent a message belongs to); it never touched how Baileys connects or
  receives. Proof: the same unchanged code read the message fine after a re-scan. The rot came
  from connection churn (the 428 flapping / WhatsApp Web fighting for the number) invalidating
  the sync token. This is inherent Baileys fragility — expect periodic re-scans. It's why
  CLAUDE.md treats Baileys as the throwaway test pipe and 360dialog as the reliable one.
- **360dialog does NOT have this failure mode.** It's the official API — webhooks in, no
  fragile login, no QR, no zombie-socket. It just keeps working. Only Baileys breaks like this.

---

## Files changed THIS session (on top of the uncommitted Phase 15 pile)

- `.env` — `AGENT_PIPE` flipped `dialog360` → `baileys` (+ a clarifying comment line).
- `scripts/regcheck.ts` — NEW, throwaway. Fixes the `you` row number typo and prints the
  registry + resolver result. Safe to keep or delete (it's idempotent — re-running just re-sets
  the already-correct number).
- **DB (Supabase) side effect:** `agents` row `you` now has `read_number = send_number =
  '971581871500'` (was `'97581871500'`). This is a data fix, not a code change.
- `baileys_auth/` — WIPED and re-linked with a fresh QR. Old (dead) creds backed up to
  `baileys_auth.bak`.

Everything from `HANDOFF-phase15-multi-agent-lane-routing.md` (the routing code) is still
uncommitted and unchanged by this session.

---

## Verification status now

| Lane | Status |
|------|--------|
| Baileys read (`you`, 971581871500) → brain → card | ✅ **VERIFIED LIVE this session** |
| Lane resolution from registry (not env) | ✅ verified (card hit correct send_number) |
| 360dialog send (bot → agent) | ✅ live since earlier phases |
| **360dialog read (Mitko → brain → card)** | ⚠️ **NOT verified** — code exists in `src/pipe/dialog360.ts`, type-checks, but no real message witnessed through it |
| Approval Yes/No tap → setMonitor | ⚠️ not tested this session |
| Q&A ("how many leads?") → agent | ⚠️ not tested this session |

---

## Leftover / next steps (in priority order)

1. **Commit Phase 15.** Still nothing committed. On `master` (not `main`). Remember the
   Co-Authored-By trailer. Suggested theme: "Phase 15: multi-agent lane routing +
   Baileys live-verified + registry number fix". Include the `.env`/registry-fix context.
2. **Remove the `[baileys:diag]` logs.** They're marked `ponytail: remove once inbound
   confirmed` in `src/pipe/baileys.ts` (the `events:`, `upsert type=`, `toEvent` lines).
   Inbound is now confirmed — safe to strip. Small clean diff.
3. **Delete `baileys_auth.bak`** — the dead-credentials backup. The fresh link works; no need
   for it.
4. **Finish the other live Baileys tests** (optional but cheap now the lane works): approval
   Yes/No tap, and Q&A to the company number.
5. **Verify the 360dialog read-lane** — the one genuinely unproven piece. Needs Mitko's number
   webhook pointed at `/agent-webhook` + a real message. Set `AGENT_PIPE=dialog360` (remember:
   global XOR switch — Baileys goes off when this is on).

---

## Known architectural limit (asked about this session)

**Can't read Baileys AND dialog360 at the same time.** `AGENT_PIPE` is a global XOR switch
(`src/server.ts:30-53`) — one read-pipe per process. Both registry rows can sit in the DB; only
the row on the ACTIVE pipe fires. This is NOT a Phase 15 limitation — the registry, lane
resolution, and per-agent card targeting are all already multi-agent-ready. The only missing
piece is starting both read-pipes in one process: a ~10-line change in `server.ts` (start
Baileys AND mount `/agent-webhook`, each gated on its own flag, instead of the if/else). The
brain doesn't change at all — that's the whole point of the pipe seam. Future work; not needed
while there's one dev number + one real agent.

---

## Gotchas carried forward

- **Baileys will need re-scanning again** eventually (credential rot from churn). Recovery:
  wipe `baileys_auth/`, restart, scan the fresh QR. Not a bug.
- **Don't keep WhatsApp Web open on `971581871500`** while Baileys runs — it causes the 428
  "connection replaced" churn that rots the login. (CLAUDE.md rule.)
- **Run the server in a visible terminal for the QR** — the ASCII QR renders in stdout and
  rotates ~every 20s; scanning it out of a background log file is impractical. Once linked, the
  auth persists, so subsequent boots can run in the background (no re-scan) until the next rot.
- **Registry is the ONLY source of identity.** A wrong digit in a row = silent total drop, no
  error. When adding/editing an agent, verify with `resolveAgentByReadNumber` before trusting it
  (that's what `scripts/regcheck.ts` is for).
