import type Anthropic from "@anthropic-ai/sdk";
import { structured } from "./claude.js";
import type { Message, Stage } from "./store.js";
import type { Qualification } from "./qualify.js";
import type { ListingSummary } from "./listings.js";

// Persona policy: .claude/skills/reply-persona/SKILL.md — read that before editing this.
const SYSTEM = `You are the response-intelligence layer for a Dubai real-estate agent on WhatsApp — the differentiator.
Given the conversation, the relationship stage, and what's already known about the lead, write EXACTLY 4 reply options the agent could send next.

Persona: calm, clear, professional — never salesy, never pushy, never sounds like a script.
Voice: real Dubai-agent WhatsApp tone — warm, human, professional, never robotic or corporate.
Real examples of the tone: "give me a call when you're free", "just tried reaching you, seems you're busy".
Test for every option: would a thoughtful human agent, who isn't in a hurry to close, actually send this?

Discovery first — this is the most important rule:
- You'll be told which of budget/area/requirement are still unknown. Do not suggest a specific area, property, or price point for any field still marked unknown — guessing signals you weren't listening.
- While fields are unknown, at least some of the 4 options should be natural discovery questions aimed at them. Not all 4 need to be questions — vary them — but none should presume an unstated fact.
- Once all three are known, replies can move toward concrete suggestions and next steps.

Reading buying timeline: never ask a direct checklist question like "what's your timeline?" or "are you a serious buyer?". Instead, when it fits, gently probe with an easy out, e.g. "no rush at all, just curious — looking to move soon or more exploring for now?". Read urgency from what the lead has already said (a deadline, a lease ending, logistics questions), never from an interrogation.

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

function knownFields(q?: Pick<Qualification, "budget" | "area" | "requirement">): string {
  const field = (label: string, v: string | null | undefined) =>
    `${label}: ${v ?? "unknown"}`;
  return [
    field("budget", q?.budget),
    field("area", q?.area),
    field("requirement", q?.requirement),
  ].join(", ");
}

function listingsBlock(listings: ListingSummary[]): string {
  if (!listings.length) return "";
  const lines = listings.map(
    (l) => `- ${l.title} — ${l.price ?? "?"} AED, ${l.bedrooms ?? "?"} bed, ${l.location}`,
  );
  return `\nMatching listings found:\n${lines.join("\n")}\n`;
}

/** Generate exactly 4 stage-aware human-worded reply options. */
export async function suggestReplies(
  messages: Message[],
  stage: Stage,
  memory = "",
  qualification?: Pick<Qualification, "budget" | "area" | "requirement">,
  listings: ListingSummary[] = [],
): Promise<string[]> {
  const convo = transcript(messages);
  const { replies } = await structured<{ replies: string[] }>(
    SYSTEM,
    `${memory}Relationship stage: ${stage}\nKnown so far — ${knownFields(qualification)}\n${listingsBlock(listings)}\nConversation so far:\n${convo}`,
    SCHEMA,
  );
  // Guarantee exactly 4 — the demo's self-check asserts this.
  // ponytail: hard-slice/pad rather than re-prompt; re-prompt if quality bites.
  const trimmed = replies.slice(0, 4);
  while (trimmed.length < 4) trimmed.push("");
  return trimmed;
}
