# FourthspaceOS — Stage-1 WhatsApp MVP

A lean, runnable demo of the one loop that matters: **inbound WhatsApp message →
AI lead qualification → 4 human-worded reply options → agent picks → send.**

Built to the **Meta Cloud API** webhook/send schema (360dialog rides the same
shape), so it runs *today* on a mock BSP with no phone number, and the real
number plugs in later behind an adapter with an env change only.

## What it does

1. **Inbound capture** — `GET/POST /webhook` in Meta Cloud API shape.
2. **AI qualification** *(Claude)* — extracts **budget / area / requirement** + the next natural question.
3. **Response intelligence** *(Claude)* — 4 stage-aware reply options in real Dubai-agent WhatsApp tone. Never auto-sends.
4. **Store** *(SQLite)* — `leads` + `messages`, `agent_id` on every row.
5. **Agent inbox** — one page: threads → extracted fields + missing + 4 replies → click to send.
6. **BSP adapter** — `MockBSP` (default, no number) / `MetaCloudBSP` (`BSP=meta`).

## Run the demo (no phone number needed)

```bash
npm install
cp .env.example .env         # add ANTHROPIC_API_KEY, leave BSP=mock
npm run dev                  # http://localhost:3000/inbox.html
npm run simulate -- "Looking for a 2BR in JVC, budget around 1.4M"
```

Open `http://localhost:3000/inbox.html` → the thread appears with budget/area/
requirement extracted, missing fields flagged, and 4 suggested replies. Click a
reply (or type your own) → `MockBSP` logs the outbound send and it shows in the
thread. Loop proven.

## Self-check

```bash
npm run check
```

Injects a fake inbound and asserts: (a) a `leads` row with `agent_id`, (b)
extracted fields populated, (c) exactly 4 reply options. Needs `BSP=mock` + a
real `ANTHROPIC_API_KEY`.

```bash
npm run typecheck            # tsc --noEmit
```

## Plugging in the Meta Cloud API test number (later)

No code change — just env + webhook registration:

1. In `.env`: set `BSP=meta`, fill `META_PHONE_NUMBER_ID` + `META_TOKEN`, set `VERIFY_TOKEN`.
2. `ngrok http 3000` to expose `/webhook`.
3. Register the ngrok URL + `VERIFY_TOKEN` in the Meta app dashboard; allow-list a recipient number.
4. Message the test number from the allow-listed phone → the reply is sent for real. Same code path.

360dialog production later = a third `BSP` implementation with the same interface.

## Deliberate corners (Stage 2/3)

- Single agent; `AGENT_ID` is a fixed env value. `agent_id` is threaded through now so multi-tenant routing is additive later.
- Reply options regenerated per inbound and cached on the thread; no queue/retry.
- No auth on `/inbox` (localhost demo) — add before any shared deployment.
- Out of scope: Zoho/CRM, portal leads, content machine, voice, developer scoring, campaigns, dedicated-number provisioning.
