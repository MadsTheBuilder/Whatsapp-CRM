# PROBLEM — Baileys read-pipe drops agent outbound to @lid contacts

Status: **DIAGNOSED, NOT FIXED.** Problem statement for a future session. No fix in this doc.
Date surfaced: 2026-07-24. Found while trying to live-test the voice-card distill job.

## One-line problem

The read-pipe cannot recover a lead's phone number on the agent's **outbound** messages
to WhatsApp privacy-`@lid` contacts, so those messages are dropped before the brain ever
sees them — which means the agent's own sent messages to such leads are never stored.

## Why it matters now

The voice-card **distill job** (Layer 2B, built and unit-passing) reads the agent's
`direction:"out"` messages to keep the voice card current. It is the FIRST feature that
depends on reading the outbound stream. It works in code but is **unreachable** for any
`@lid` lead because its input is dropped upstream. Live test result: 4 messages sent to a
`@lid` lead → **0 outbound rows stored**, distill never ran. (Inbound suggestion cards are
unaffected — they've always worked, see below.)

## Background: what @lid is

WhatsApp rolled out `@lid` ("linked id") — an opaque per-contact identifier
(e.g. `7232909500553@lid`) that WhatsApp shows **instead of** the real phone number for
some contacts (privacy feature). It is NOT the phone number. Our entire lead model keys on
**phone** (`leads` unique key is `(agent_id, phone)`; the brain looks up via
`findLeadByPhone`), so a `@lid` message must be resolved to a phone before it's usable.

## The exact asymmetry (this is the whole bug)

WhatsApp attaches the real phone in the message key field `senderPn` — but only in one
direction:

| Direction | remoteJid | fromMe | senderPn (the phone) | Result today |
|-----------|-----------|--------|----------------------|--------------|
| Lead → Agent (inbound) | `<lid>@lid` | false | ✅ present (lead's phone) | works — lead created/keyed by phone |
| Agent → Lead (outbound) | `<lid>@lid` | true  | ❌ **absent** (`NONE`)    | **DROPPED** |

On an outbound message the `@lid` is the *recipient's* id, and WhatsApp does not include
the recipient's phone. So there is no phone on the message at all.

The drop happens here — [src/pipe/baileys.ts:92](../src/pipe/baileys.ts#L92):
```
if (isLid && !senderPn) return null; // lid with no phone — unusable, drop
```
This guard is correct in intent (without it, the opaque lid digits would masquerade as a
phone and spawn a garbage duplicate lead). It just has no way to recover the real identity
on outbound.

## Evidence captured this session (live Baileys)

```
[baileys:diag] toEvent jid=7232909500553@lid fromMe=true isLid=true senderPn=NONE text="Hey Madhur good afternoon..."
[baileys:diag] toEvent jid=7232909500553@lid fromMe=true isLid=true senderPn=NONE text="Binghatti galaxy 1 bed..."
```
- `fromMe=true` → agent sent it. `senderPn=NONE` → no phone. → dropped at line 92.
- **The `@lid` id is STABLE across messages** to the same contact (`7232909500553` both
  times). This is the key fact that makes a fix feasible.

DB confirmation after 4 sends: `messages` outbound total = **0**;
`agent_persona_versions` = **no rows**; `agent_persona.card_upto` = **0**.

## Constraints that shape the fix

- **Baileys 6.7.23 has NO `@lid → phone` lookup API** (checked: no `getPNForLID` /
  `lidMapping` in this version). So we cannot ask Baileys to translate a lid to a phone.
- The `@lid` **is stable per contact**, and on INBOUND we DO get both the phone (`senderPn`)
  and the lid (`remoteJid` / `senderLid` on the key). So the link phone↔lid is learnable —
  but only once the lead has messaged inbound at least once.
- The message key type carries `senderLid`, `senderPn`, `participantLid`, `participantPn`
  ([node_modules/@whiskeysockets/baileys/lib/Types/Message.d.ts:16-21]).

## Decision already made (this session)

**Cold outbound = drop.** If the agent messages a `@lid` contact who has NEVER messaged
inbound (so we have neither phone nor a stored lid), we cannot identify them and there is
nothing to learn from a one-way blast — drop it. Only contacts with at least one real
inbound (which gives us the phone+lid link) feed the voice card. This avoids the
lid-only-lead → later-inbound-lead SPLIT problem entirely.

## Fix shape (for the next session — NOT done here)

Roughly a 4-touch change; keep the pipe-agnostic seam intact (the brain must not learn
about lids — resolution happens in the pipe/store, the brain still gets a normalized event):

1. **Migration** — add a nullable `lid text` column to `leads` (+ index on `(agent_id, lid)`).
2. **baileys.ts** — extract the contact's `@lid` from the message key on BOTH directions;
   pass it through (or resolve it before handing the brain a phone-keyed event).
3. **store.ts** — on inbound, store the lead's `lid` alongside phone; add
   `findLeadByLid(agentId, lid)`.
4. **brain.ts** — when an event has no phone (outbound `@lid`), resolve the lead by `lid`
   instead of phone. If no lead matches (cold outbound) → drop, per the decision above.

Keep the existing line-92 drop for the genuinely-unresolvable case (no phone AND no known
lid). The goal: inbound-Madhur (phone-keyed) and outbound-Madhur (lid-keyed) resolve to the
SAME lead, no split.

## Verification when fixed

Send N messages from the agent's phone to a `@lid` lead that has messaged inbound before;
confirm outbound rows land in `messages` and (with DISTILL_THRESHOLD reached) the distill
fires — `agent_persona_versions` gets a row and `card_upto` advances.

## Out of scope for the fix

- 360dialog pipe (this is Baileys-only; 360dialog gives phone numbers directly).
- Any lid→phone reverse lookup (Baileys can't; we sidestep it by keying on lid).
- Cold-outbound lead creation (decided: drop).
