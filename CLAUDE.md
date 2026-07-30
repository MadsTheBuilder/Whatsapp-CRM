# CLAUDE.md

This file tells Claude Code what we are building and the rules of the build. Everything below replaces all earlier plans. Nothing from the old version carries over. If you find old code or old docs in this folder that disagree with this file, this file wins.

your responses should never be too verbose, techinical and complex. always choose a simple response meathod when giving a respose


## What we are building (in plain words)

A helper for real-estate agents who sell property in Dubai.

An **agent** talks to their customers ("leads") on WhatsApp, on the agent's own number. There is also a second WhatsApp number, the **company number**, which is a bot. The bot quietly watches the agent's conversations with leads and privately helps the agent — like an assistant texting the agent on the side.

The bot helps in four ways:

1. **Suggested replies** — the bot reads what the lead just said and privately messages the agent a good reply to send. The agent copies it and sends it to the lead themselves.
2. **Lead summaries** — the bot keeps a short summary of each lead (what they want, budget, area, where the deal stands).
3. **Follow-up reminders** — once a day the bot checks for leads the agent has not contacted in 3 days and sends the agent a reminder.
4. **Questions on demand** — the agent can text the company number things like "how many leads am I working on?" or "how many are qualified?" and get an answer back.

That is the whole product for the first version.

## Who talks to whom (read this before touching any code)

There are three parties:

- **Lead** — the customer. Messages the **agent's** WhatsApp number.
- **Agent** — the human salesperson. Talks to leads on their own number. Also receives private help from the bot on the **company** number, and can ask the company number questions.
- **Bot (company number)** — our software. Never talks to the lead. Only talks to the **agent**.

The message flows:

- Lead → Agent's number → **our software sees it** (because the agent's number is on 360dialog) → bot writes a suggestion → bot → Agent (on company number).
- Agent → Lead: the agent sends this themselves by copying the bot's suggestion. Our software does **not** send messages to leads.
- Agent → Company number: a question like "how many qualified leads?" → bot answers the agent.

**Key fact that makes this possible:** our software must be able to **see the messages on the agent's number**. That is the only reason it can help. *How* it sees them is a swappable pipe (see "The two numbers and the swappable pipe" below) — today the agent side is read through Baileys, later through 360dialog. Either way, if a number is not connected to one of our pipes, our software is blind to it. Do not design anything that assumes we can read a plain, unconnected phone's WhatsApp — we cannot.

## Hard rules we cannot break

- **The bot never messages a lead, with one narrow exception:** relaying a portal
  lead-notification message (PropertyFinder today) that a third party already wrote,
  verbatim, from the listing agent's own number, as the first message on a brand-new
  lead. See [wa_plan/portal-lead-outreach-PROBLEM.md](wa_plan/portal-lead-outreach-PROBLEM.md)
  for the full design. No other bot→lead send exists. No AI-generated or edited
  outreach content, ever. Everything after that first relayed message goes back to the
  normal rule below.
- **Outside that one exception, the agent sends all replies to leads by hand** (copy
  the suggestion, paste, send). Our software is otherwise read-only toward the lead
  conversation: it reads, it never sends to the lead. (This also keeps us safe from
  WhatsApp's 24-hour messaging rule and template requirements — we don't message
  strangers with AI-generated content.)
- **Our software must be able to read the agent's messages** or the product does not work. This is an assumption, not a feature to build. (The company number is on 360dialog; the agent number is read through a swappable pipe — see below.)

## The two numbers and the swappable pipe

There are two WhatsApp numbers, and each connects to our software differently.

**Company number — 360dialog (live now).** This is the bot's number. It only ever *sends* to the agent (suggestions, summaries, reminders, answers). It stays on the official 360dialog channel because we want the part that sends messages to be reliable and allowed.

**Agent number — a swappable pipe.** Our software needs to *read* the messages on the agent's number. It does not send to the lead — only reads. How it reads is swappable:

- **Today (testing):** the developer's own private number, read through **Baileys** (a free, unofficial WhatsApp connection). This lets us build and test the whole system now, without waiting for a second 360dialog number. Only the developer's own account is at risk, which is accepted for testing.
- **Later (real broker):** a second **360dialog** number for the real agent. When it's ready, we swap the pipe — no change to the brain.

**The seam that makes the swap cheap:** both pipes feed the exact same internal shape into the brain — one "a message happened on the agent's number" object, roughly `{ agentId, leadNumber, direction, text, timestamp }`. Baileys feeds it from its message event; 360dialog feeds it from its webhook. **The brain must never know or care which pipe a message came from.** Build this seam from the start. Do NOT wire Baileys directly into the qualify/summarize/suggest logic — that would turn the later swap into a rewrite.

Notes for the Baileys test setup:
- Save the login keys once (locally is fine for now; move to Supabase when deployed) so the QR is scanned **once**, not every restart.
- Auto-reconnect on a dropped connection; only a real "logged out" reason needs a fresh QR scan.
- Don't keep WhatsApp Web open on the same private number while Baileys is connected — they knock each other offline.

## Where data lives

Everything is stored in **Supabase** (an online database). There is no local database file. If you see references to a local SQLite file or `fourthspace.db` anywhere, that is old and wrong — ignore it.

We store, per lead:

- which agent the lead belongs to (`agent_id`)
- the lead's contact (their WhatsApp number / name)
- the conversation transcript (messages between agent and lead)
- a short summary of the conversation
- the lead's stage (where the deal stands)

Note: the Supabase project currently has junk from old builds in it. We are wiping it clean and starting fresh.

## One agent now, many agents later

The first working version is for **one agent**. But every piece of data carries an `agent_id`, so adding more agents later does not require a redesign. Build for one; leave the door open for many. Do not build multi-agent login/permissions yet — just keep the `agent_id` on everything.

## The WhatsApp provider

We use **360dialog** as the WhatsApp provider for both numbers. We have one 360dialog number available today. 360dialog offers a "coexistence" mode (the same number works in the normal WhatsApp app AND through the API) — that is what lets the agent keep using WhatsApp normally while our software also sees the messages.

## What is deliberately NOT in the first version

Do not build these yet. If they seem needed, stop and ask first.

- The bot auto-sending anything to a lead — except the one narrow portal-relay
  exception above.
- Multi-agent accounts, logins, or per-agent permissions (data is agent-tagged, but there is one agent for now).
- Any CRM / portal / campaign / voice / content features.
- Fancy dashboards or web UIs unless we specifically decide we need one.

## How to work in this repo

- The existing code in this folder is from an older, different plan and is not trusted. Do not assume any file is correct because it exists. When in doubt, check with the user before reusing old code.
- Keep it simple. This is a small system. Prefer the fewest moving parts that make the four helper features work.
- When something is genuinely unclear about how a lead, agent, or the bot should behave, ask a plain-language question rather than guessing.
