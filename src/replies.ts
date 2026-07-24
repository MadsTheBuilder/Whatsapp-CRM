import type Anthropic from "@anthropic-ai/sdk";
import { structured, REPLY_MODEL } from "./claude.js";
import type { Message, Stage } from "./store.js";
import type { Qualification } from "./qualify.js";
import type { ListingSummary } from "./listings.js";

// Persona policy: .claude/skills/reply-persona/SKILL.md — read that before editing this.
const SYSTEM = `You are the response-intelligence layer for a Dubai real-estate agent on WhatsApp — the differentiator.
Given the conversation, the relationship stage, and what's already known about the lead, write EXACTLY 4 reply options the agent could send next.

Persona: calm, clear, professional — never salesy, never pushy, never sounds like a script.
Voice: real Dubai-agent WhatsApp tone — warm, human, professional, never robotic or corporate.
If real examples of THIS agent's own messages are provided below, mirror their voice — sentence length, greetings, sign-offs, emoji habits, the way they actually phrase things. Those samples outrank any generic idea of "professional"; sound like that specific person, not a polished template.
Test for every option: would a thoughtful human agent, who isn't in a hurry to close, actually send this?

Grounding — the hard rule. You'll be given a list of ANSWERED facts and a list of what's still UNKNOWN:
- Never RE-ASK a fact that's in the ANSWERED list. If the lead already told you their budget, area, deal type, beds, or timeline, treat it as settled — asking again signals you weren't listening.
- Never ASSERT a fact that isn't in the ANSWERED list. Do not name a specific area, property, price, unit type, or amenity for anything marked UNKNOWN — guessing is worse than asking.
- These lists are the ground truth, not your memory of the transcript. Key every option off them.

Discovery vs. situation-awareness — scale it to how much is UNKNOWN:
- While anything is UNKNOWN, at least some of the 4 options should be natural discovery questions aimed at the gaps. Not all 4 need to be questions — vary them — but none should presume an unstated fact.
- Once everything is ANSWERED (nothing left UNKNOWN), the lead is qualified: stop spending options on discovery. AT MOST ONE option may be a soft, low-pressure probe; the other three must be situation-aware moves that respond to what the lead JUST said, each from a different angle — e.g. addressing their objection, proposing a concrete next step (viewing, a specific idea), reassuring/reflecting their stated timeline back, or offering to act on their behalf (negotiate, pull options). Never let three of four drift back into generic questions or restating facts they already gave you when the moment calls for a move.
- A question is not required in a reply — it's a tool, not a habit. A plain statement or a proposed move ("I'll confirm 85k with the landlord and get back to you") is a complete, valid reply. For a qualified lead, most options should NOT end in a question; only include one where it's genuinely the natural next beat, not out of reflex. Do not append a tacked-on question to a reply that already stands on its own.

Reading buying timeline: if timeline is in the ANSWERED list, the lead has already told you when they're moving — do NOT ask about it again; instead reflect it back naturally where it fits ("makes sense with your lease ending then"). Only if timeline is UNKNOWN may you gently probe, and never as a checklist question ("what's your timeline?", "are you a serious buyer?") — use an easy out, e.g. "no rush at all, just curious — looking to move soon or more exploring for now?". Read urgency from what the lead said, never from an interrogation.

Urgency and curiosity must come only from the conversation itself — never invent market data, scarcity, or stats you can't verify. Reflect the lead's own stated timeline back to them, or open a curiosity gap ("I've got a couple of thoughts on that area, want me to share?") — never manufacture pressure.

Match the stage:
- first_contact: opening / building rapport, gently qualifying.
- following_up: chasing a lead who went quiet, light and no-pressure.
- deep: several conversations in — concrete, moving toward viewing/next step.
Vary the 4 options so the agent has a genuine choice. Never auto-send — the agent picks one.

If matching listings are provided, weave 1-2 of the strongest into your options naturally (e.g. mention the area/price/bedroom count and offer to share details or set up a viewing) — never dump a raw list or invent details beyond what's given.`;

const SCHEMA: Anthropic.Tool.InputSchema = {
  type: "object",
  properties: {
    replies: {
      type: "array",
      items: { type: "string" },
      description: "Exactly 4 reply options.",
    },
  },
  required: ["replies"],
};

function transcript(messages: Message[]): string {
  return messages
    .map((m) => `${m.direction === "in" ? "Lead" : "Agent"}: ${m.body}`)
    .join("\n");
}

// The discrete answered-field set the reply model keys its grounding rule off.
// Passed as two explicit lists (ANSWERED / UNKNOWN) so the model never re-asks a
// stated fact nor asserts an unstated one — the input-contract fix. `requirement`
// is intentionally omitted: it's just deal_type/unit_type/beds joined, already here.
type QualFields = Pick<
  Qualification,
  "budget" | "area" | "deal_type" | "unit_type" | "beds" | "timeline"
>;
const FIELD_LABELS: [keyof QualFields, string][] = [
  ["budget", "budget"],
  ["area", "area"],
  ["deal_type", "buy or rent"],
  ["unit_type", "property type"],
  ["beds", "bedrooms"],
  ["timeline", "move-in timeline"],
];

function groundingBlock(q?: QualFields): string {
  const answered: string[] = [];
  const unknown: string[] = [];
  for (const [key, label] of FIELD_LABELS) {
    const v = q?.[key];
    if (v) answered.push(`${label}: ${v}`);
    else unknown.push(label);
  }
  return (
    `ANSWERED (never re-ask): ${answered.length ? answered.join(" · ") : "nothing yet"}\n` +
    `UNKNOWN (never assert): ${unknown.length ? unknown.join(", ") : "all captured"}`
  );
}

// Layer 3: a handful of the agent's own recent texts, verbatim, so the model
// mirrors THIS agent's voice instead of a generic one. Empty until the agent has
// sent messages (cold start → generic voice, never worse than today).
function samplesBlock(samples: string[]): string {
  if (!samples.length) return "";
  const lines = samples.map((s) => `- ${s}`).join("\n");
  return `\nHow THIS agent actually writes (recent real messages — mirror this voice, don't copy the content):\n${lines}\n`;
}

// Layer 2: the agent's onboarding voice card (markdown blob from the role-play
// skill). Distilled intent — rides ahead of live samples. Empty until onboarded.
// Exported for the self-check (scripts/voicecard.test.ts).
export function voiceCardBlock(card: string): string {
  return card.trim() ? `\n${card.trim()}\n` : "";
}

function listingsBlock(listings: ListingSummary[]): string {
  if (!listings.length) return "";
  const lines = listings.map(
    (l) => `- ${l.title} — ${l.price ?? "?"} AED, ${l.bedrooms ?? "?"} bed, ${l.location}`,
  );
  return `\nMatching listings found:\n${lines.join("\n")}\n`;
}

/** Generate exactly 4 stage-aware human-worded reply options in the agent's voice. */
export async function suggestReplies(
  messages: Message[],
  stage: Stage,
  memory = "",
  qualification?: QualFields,
  listings: ListingSummary[] = [],
  card = "",
  samples: string[] = [],
): Promise<string[]> {
  const convo = transcript(messages);
  const { replies } = await structured<{ replies: string[] }>(
    SYSTEM,
    `${memory}Relationship stage: ${stage}\n${groundingBlock(qualification)}\n${voiceCardBlock(card)}${samplesBlock(samples)}${listingsBlock(listings)}\nConversation so far:\n${convo}`,
    SCHEMA,
    REPLY_MODEL, // route the voice-critical call to its own (bigger) model
  );
  // Guarantee exactly 4 — the demo's self-check asserts this.
  // ponytail: hard-slice/pad rather than re-prompt; re-prompt if quality bites.
  const trimmed = replies.slice(0, 4);
  while (trimmed.length < 4) trimmed.push("");
  return trimmed;
}
