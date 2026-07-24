---
name: voice-extraction-role-play
description: Onboard a real-estate agent's WhatsApp voice by role-playing leads at them and extrapolating a voice card. Use when a new agent needs a voice_card seeded into agent_persona (Layer 2 of the personalized-reply system), when asked to "onboard an agent's voice", "run the voice role-play", "capture the agent's tone", or "seed the voice card". Produces the tight-markdown card that getVoiceCard() feeds into every suggestReplies() prompt. Venue-agnostic — runs wherever the agent can type back.
---

# Voice Extraction — Role-Play Onboarding

Seed a per-agent **voice card** by playing leads at the agent and reading their real replies.
The card is a short markdown blob that lands in `agent_persona.voice_card` and rides ahead of
live samples in every reply prompt (see [voice-roleplay-onboarding-PLAN.md](../../../wa_plan/voice-roleplay-onboarding-PLAN.md)).

**You (Codex) play the lead. The agent replies AS THEMSELVES** — not editing a draft, not being
interviewed. Their true voice is extrapolated from how they handle a series of deliberately
different leads.

## Hard rules — this is pure capture, not coaching

- **Never coach.** Do not suggest a better reply, never show a "good" example to compare against,
  never score. The moment you model a reply, you contaminate the signal.
- **One lead at a time, in order.** Present the scenario, present the lead's message, then stop and
  wait for the agent's real reply. Do not move on until they answer.
- **Neutral acknowledgement only.** After each reply, at most one soft, non-leading follow-up —
  "curious why you phrased it that way?" — and only if it feels natural. Then move to the next.
- **Their words are the evidence.** Keep 3-4 of their actual replies verbatim for the card.

## Session flow

1. **Intro** (2 lines): "I'll play a series of different leads. Reply to each exactly as you would
   on WhatsApp right now — your real words, no editing. There's no right answer; I'm just learning
   your voice." Then add: "There are 12 in all — we don't have to do every one. Tell me to wrap up
   whenever and I'll build your card from what we've done."
2. **Run the scenarios in order.** For each: present the lead context + message, wait, capture the
   reply, optional soft "why?", next. **Minimum 4** for a usable card; more sharpens it.
3. **Produce the card** in the format below. Show it to the agent. Ask them to confirm or nudge.
4. **Save it** to `agent_persona` (see Storage).

## Scenarios

Each scenario isolates one voice dimension that real chats muddy together. Run them in order; the
first 4 cover the core dimensions, and a card built from just those is valid — the rest add nuance.

### Scenario 1 — The Ready Buyer
*(warmth, confidence, brevity, how they push to a viewing)*

Lead: Abu, 45, engineer, bought in Dubai before, cash ready, moving fast.
His message:
> Hi, I've got cash ready and want to close on a 2BR in Jumeirah within a month.
> What's available in the 3-4M range? Can we do a viewing this week?

Your turn: reply to Abu as you would on WhatsApp right now. Just your real response.

### Scenario 2 — The Low-Intent Browser
*(patience, gentle qualification, casual-tone emoji, boundary-setting without pushiness)*

Lead: Sarah, 28, curious, no budget or timeline.
Her message:
> Hey! Just browsing for fun 😊 what kind of apartments do you have?
> Nothing specific, just curious what's out there.

Your turn: reply to Sarah as you would on WhatsApp right now.

### Scenario 3 — The Frustrated Client
*(composure, own-the-mistake vs defensive, de-escalation phrasing)*

Lead: Hassan, 50, upset — last 5 viewings didn't match what he asked for, considering leaving.
His message:
> This is ridiculous. You showed me 5 places and none were close to what I said.
> I want a refund of the viewing fees or I'm going to another agent.

Your turn: reply to Hassan as you would on WhatsApp right now.

### Scenario 4 — The Re-Engagement
*(follow-up opener, personalization, soft re-engagement vs hard chase, sign-off)*

Lead: Fatima, 35, was interested in JVC, silent for 2 weeks. YOU initiate — she hasn't messaged.

Your turn: write a follow-up to Fatima. What do you send to check in?

### Scenario 5 — Price / Commission Pushback
*(defending value without caving or getting defensive; how they talk about money)*

Lead: Ravi, 40, keen on a 1.9M apartment but pushing hard on cost.
His message:
> The price is way too high for that building, and honestly 2% commission on top is a lot.
> Can you get the seller down, or at least cut your fee? Otherwise I'll keep looking.

Your turn: reply to Ravi as you would on WhatsApp right now.

### Scenario 6 — Comparison Shopping
*(handling being played off a competitor — poise vs badmouthing rivals)*

Lead: Mei, 33, says another agent quoted the same unit for less.
Her message:
> Another agent showed me the exact same unit and said he can do it cheaper.
> Why should I go with you? What can you actually do that he can't?

Your turn: reply to Mei as you would on WhatsApp right now.

### Scenario 7 — Ghosting After a Viewing
*(nudge tone when momentum stalls mid-deal — re-open without pressure)*

Lead: Karan, 38, viewed a townhouse two days ago, seemed to love it, then went silent. YOU initiate.

Your turn: write the message you'd send Karan to check in after the viewing.

### Scenario 8 — The Skeptic
*(building credibility and trust without sounding defensive or salesy)*

Lead: Yousef, 47, first-time buyer, wary of agents in general.
His message:
> How do I even know you're legit and not just chasing your commission?
> Every agent says the same things. Convince me you're different.

Your turn: reply to Yousef as you would on WhatsApp right now.

### Scenario 9 — The Kickback Ask
*(holding an ethical line while staying warm — composure under an awkward, direct ask)*

Lead: Deepa, 42, ready to proceed on a 2.4M unit, but wants a private arrangement.
Her message:
> Look, I'll sign today if you give me 1% back from your commission, cash, between us.
> Every agent does it. Deal?

Your turn: reply to Deepa as you would on WhatsApp right now.

### Scenario 10 — The Overseas Investor
*(explaining-mode voice — reassurance on process, paperwork, buying remotely)*

Lead: James, 51, in London, never been to Dubai, wants to invest but is nervous about doing it remotely.
His message:
> I've never been to Dubai and I'd be buying entirely remotely.
> How does the whole process even work — payment, paperwork, handover? Is it safe to do from abroad?

Your turn: reply to James as you would on WhatsApp right now.

### Scenario 11 — The Over-Eager Lead
*(setting pace and managing expectations warmly, not curtly)*

Lead: Priya, 30, excited, has messaged five times in an hour and expects instant answers.
Her latest messages:
> Hi did you get my last message?? 🙏
> Sorry to keep messaging! Just really excited. Can you send everything you have right now?
> Also can we view today or tomorrow? And is the price negotiable? And parking?

Your turn: reply to Priya as you would on WhatsApp right now.

### Scenario 12 — The Terse Texter
*(does the agent mirror a low-effort message or elevate it — energy calibration)*

Lead: Omar, 36, sends bare, clipped messages.
His message:
> villa? price?

Your turn: reply to Omar as you would on WhatsApp right now.

## Card format — tight markdown, not JSON

One short blob. It rides in EVERY reply prompt, so keep each line to one line:

```
VOICE (from onboarding):
- length/rhythm: <1 line>
- vocabulary & language mix: <1 line>
- emoji & punctuation: <1 line>
- greeting/sign-off: <1 line>
- warmth vs pressure: <1 line>
- objection/sales moves: <1 line>
- money & ethics: <1 line — how they handle price pushback, competitors, kickback asks>
- signature quirks: <1 line>
Real examples: <3-4 of the agent's own role-play replies, verbatim>
Never: <2-3 negative-space rules, e.g. "never uses exclamation marks", "never chases twice">
```

Extrapolate every line ONLY from what the agent actually wrote. Do not invent traits they didn't
show. If a dimension never came up (e.g. they stopped after scenario 4), leave that line out or
mark it "not observed" — never guess.

## Storage

Save the confirmed card to Supabase (`agent_persona` table, created by migration
`005_add_agent_persona.sql`). Upsert on `agent_id`:

```sql
insert into agent_persona (agent_id, voice_card, updated_at)
values ('<AGENT_ID>', '<card markdown>', now())
on conflict (agent_id) do update
  set voice_card = excluded.voice_card, updated_at = now();
```

Leave `card_upto` at its default (0) — it's a watermark for the future distill job, unused now.
`getVoiceCard()` in [src/store.ts](../../../src/store.ts) reads it back; a null/absent card means
generic fallback, so a failed save just returns today's behavior, never worse.
