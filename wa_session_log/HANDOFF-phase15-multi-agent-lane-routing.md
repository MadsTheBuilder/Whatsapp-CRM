# HANDOFF phase15 — Multi-agent lane routing (identity from the message, not from env)

Date: 2026-07-24
Branch: `master` (main branch is `main`)
Status: **code complete + type-checks + parser self-checks pass. NOT yet live-verified end-to-end. Uncommitted.**

---

## What this phase did (the problem it fixed)

Before: agent identity was decided **twice by env vars, never by the message**:
- Inbound — every message stamped `agentId: AGENT_ID` at the pipe door (from env).
- Outbound — every bot message (suggestion / approval / stage prompt / reminder / Q&A answer) sent to the single `AGENT_COMPANY_NUMBER`.

Consequence: add a 2nd agent and both agents' leads pool under one `AGENT_ID`, and both agents' cards go to one phone. Agent A gets Agent B's cards.

Fix: **the receiving number on each inbound message selects the lane end-to-end.** A registry table maps each agent's `read_number` → `{ agent_id, send_number }`. Every lead, message, and bot reply is scoped to the agent whose number carried the message. **Registry is the ONLY source of identity — no env fallback.** `AGENT_ID` / `AGENT_COMPANY_NUMBER` / `AGENT_NUMBER` env vars are retired (except one out-of-scope dashboard use in api.ts).

Plan file: `C:\Users\madhu\.claude\plans\the-problem-statement-the-wobbly-metcalfe.md`

---

## The mental model (say this back to yourself before touching anything)

- **Company/bot number** = the ONE sender (the "from"). Set via `COMPANY_BOT_NUMBER` + the 360dialog send channel. Shared across all agents.
- **`send_number`** (per registry row) = each agent's OWN phone — the "to". The bot sends *from* the one company number *to* each agent's own number. Must be **distinct per agent** (a shared send_number breaks `resolveAgentBySendNumber`'s `.maybeSingle()` lookup AND re-merges outbound).
- **`read_number`** = the number the bot reads leads on (display_phone_number on dialog360; the QR-scanned number on baileys).
- Many read-numbers → many send-numbers (agents' phones) → one bot sender. That's the invariant.
- Normal case: `read_number == send_number` for a given agent (they read leads and receive help on one phone).

---

## Files changed (all uncommitted)

New:
- `src/pipe/dialog360.ts` — was already `??`-new; now resolves agent from `value.metadata.display_phone_number`.
- `scripts/dialog360parse.test.ts` — offline parser self-check.

Modified (production path):
- `supabase/schema.sql` — added `agents` table; also added the two missing `drop table` lines for `agent_persona` / `agent_persona_versions` so the file is now idempotent/re-runnable.
- `src/store.ts` — added `Agent` interface + `resolveAgentByReadNumber`, `resolveAgentBySendNumber`, `listAllAgents`, `registerAgent` (numbers normalized to bare digits via `digitsOnly`).
- `src/pipe/types.ts` — added `sendNumber: string` to `AgentMessageEvent`.
- `src/pipe/dialog360.ts` — door reads display_phone_number, `resolveAgentByReadNumber`, drops unregistered, stamps `agentId`+`sendNumber`. `toEvent` is now a pure transform (identity blank). Retired `AGENT_ID`/`AGENT_NUMBER` env.
- `src/pipe/baileys.ts` — resolves the dev agent once on `connection === "open"` from `sock.user.id` → `jidToNumber` via `resolveAgentByReadNumber`; holds it in a module-scoped `agent` var; drops all inbound while `agent` is null (never stamps a guessed identity). Retired `AGENT_ID` env.
- `src/notify.ts` — `notifyAgent(to, body)`, `askApproval(to, phone, name?)`, `askStage(to, phone, name, qualLine)` — destination is now the first arg, not env.
- `src/brain.ts` — threads `ev.sendNumber` into all three fire-and-forget outbound calls.
- `src/company.ts` — resolves the asking agent from `msg.from` via `resolveAgentBySendNumber`; drops unregistered senders; threads `agentId` into `handleApproval`/`handleStageSelection`/`handleStageCommand`; every reply via `notifyAgent(agent.send_number, ...)`.
- `src/qa.ts` — `answerAgentQuestion(agentId, text)`; retired `AGENT_ID` env.
- `src/reminders.ts` — `runDailyReminders()` iterates `listAllAgents()`, one digest per agent to its own `send_number`; new private `runAgentReminders(agentId, sendNumber)`. Return type is now `Map<string, string|null>`. Retired `AGENT_ID` env.
- `src/api.ts` — added `POST /api/agents` (register) + `GET /api/agents/registry` (list). NOTE: dashboard board routes still use env `AGENT_ID` on purpose — marked `ponytail:` as out of scope (dashboard agent-selection is a separate feature).
- `scripts/{simulate,memcheck,repro-november}.ts` — injected events now include `sendNumber: process.env.AGENT_COMPANY_NUMBER ?? ""` (sim harnesses only; they call the store directly, unaffected by the fix).
- `scripts/baileyparse.test.ts` — expects blank `agentId`/`sendNumber` from the pure `toEvent`.

Also in the working tree (pre-existing, unrelated to this phase): a big pile of `archive/**` deletions staged. Leave or handle separately.

---

## What's been verified

- `npx tsc --noEmit` → clean (exit 0).
- `npx tsx scripts/baileyparse.test.ts` → passed.
- `npx tsx scripts/dialog360parse.test.ts` → passed.
- `scripts/reminderlogic.test.ts` (with dummy SUPABASE env) → passed.

**NOT verified:** live end-to-end lanes (real webhooks, real taps, two numbers). Needs the DB + a running server + a configured 360dialog webhook. Couldn't do it from the planning session (Supabase MCP unauthorized).

---

## DB state (done by the user in the SQL Editor)

- Ran the schema. All 7 tables exist: `agents`, `leads`, `messages`, `memory`, `agent_persona`, `agent_persona_versions`.
  - (Earlier hiccup: user ran the "just agents table" snippet, then the full file, hit `42P07 relation "agent_persona" already exists` because the file didn't drop the persona tables. Fixed the file to drop all six. Harmless — all tables ended up present.)
- **Seeded agents** (user confirmed "i ran the command"):
  ```sql
  insert into agents (agent_id, read_number, send_number, name) values
    ('mitko', '971523398688', '971523398688', 'Mitko'),
    ('you',   '971581871500', '971581871500', 'Dev/You');
  ```
  - Mitko `971523398688` = his 360dialog channel number (matches the live display_phone_number we saw).
  - "you" `971581871500` = the number to scan the Baileys QR with.
  - **⚠️ VERIFY the "you" number.** User first typed `+97581871500` (11 digits — too short; UAE = 12). I inferred `971581871500`. **Confirm this is the exact number the Baileys QR is scanned with** — if the digits don't match what Baileys reports for `sock.user.id`, the lane silently never matches and every message is dropped.
  - **Also confirm** `971581871500` (your personal WhatsApp) is DIFFERENT from `COMPANY_BOT_NUMBER` (was `971581137568` in an earlier test). They must be distinct numbers.

---

## CRITICAL runtime constraint — one pipe at a time

`AGENT_PIPE` is a **global switch** (`src/server.ts:30`), baileys XOR dialog360 for the whole server:
- `AGENT_PIPE=dialog360` → Mitko's `/agent-webhook` mounted; **Baileys off** (your dev number won't read).
- `AGENT_PIPE=baileys` (default) → your dev number reads; Mitko's webhook not mounted.

Both registry rows can sit in the table regardless — only the row whose number is on the ACTIVE pipe fires. To run Mitko live: `AGENT_PIPE=dialog360` + confirm the 360dialog dashboard points the agent number's webhook at `/agent-webhook` (reuses `DIALOG360_VERIFY_TOKEN` for the GET handshake unless `AGENT_DIALOG360_VERIFY_TOKEN` is set).

Running BOTH agents live simultaneously in one process is NOT possible today (would need a second read-pipe wired in — future work).

---

## Next steps to continue (in order)

1. **Confirm the "you" number** is exactly the Baileys-scanned number (see ⚠️ above). Fix the row if wrong:
   `update agents set read_number='<correct>', send_number='<correct>' where agent_id='you';`
2. **Pick a pipe** and set `AGENT_PIPE` in `.env` accordingly.
3. **Live-verify one lane** (plan's verification steps):
   - Start the server. For baileys: scan QR with the `you` number, watch for `[baileys] agent lane: you (read ... → send ...)`. If you see `number ... is not registered` → the row number ≠ scanned number; fix step 1.
   - Send a real lead message → confirm a suggestion card lands on the right send_number and the lead row has the right `agent_id`.
   - Tap an approval Yes/No → confirm `setMonitor` flips the right agent's lead.
   - Text the company number a question ("how many leads?") → confirm the answer counts only that agent's leads and returns to that agent.
4. **Multi-agent isolation** (once Mitko's webhook is live on dialog360): POST fake `/agent-webhook` bodies with each `display_phone_number` and assert leads/cards route to the correct lane; assert the same lead-phone under both agents makes two distinct rows.
5. **Unregistered-number drop**: POST with an unknown display_phone_number → asserted dropped (log line, no lead written).
6. **Commit.** Nothing is committed yet. Suggested message theme: "Phase 15: multi-agent lane routing — identity from receiving number via agents registry". Remember the Co-Authored-By trailer. On `master`, not `main`.

---

## Gotchas / things to know

- **Baileys race:** `messages.upsert` could fire before the async agent-resolve on `open` completes. Guard drops those first message(s) with a log — self-heals on the next message. Fine for a persistent dev session; noted, not a bug.
- **`sock.user.id`** is typically `<number>:<device>@s.whatsapp.net`; `jidToNumber` strips it to bare digits — matches how `read_number` is stored. Good.
- **Number normalization:** `registerAgent` and both resolvers run `digitsOnly` (strip non-digits), so a stray `+`/space in a registry row or an inbound number can't cause a silent miss. But the SEEDED rows are already bare digits.
- **api.ts dashboard `AGENT_ID`** is deliberately left on env (out of scope). Don't "fix" it as part of this — it's a separate dashboard-agent-selection feature.
- **`answerAgentQuestion` signature changed** to `(agentId, text)` — only caller is company.ts, already updated.
- **`runDailyReminders` return type changed** to `Map` — only caller is server.ts's tick, which only `.catch()`es, so no break.
