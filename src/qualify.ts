import type Anthropic from "@anthropic-ai/sdk";
import { structured } from "./claude.js";
import type { Message } from "./store.js";

export interface Qualification {
  budget: string | null;
  area: string | null;
  requirement: string | null;
  next_question: string | null;
}

const SYSTEM = `You qualify real-estate leads for a Dubai property agent from a WhatsApp conversation.
Extract exactly three fields when the lead has stated them:
- budget: the price range or budget (e.g. "1.4M AED", "around 2 million"). null if not stated.
- area: the location/community they want (e.g. "JVC", "Dubai Marina"). null if not stated.
- requirement: what they want — buy vs rent, and property type (off-plan / secondary / rental type, bedrooms). null if not stated.
Do not guess or infer values the lead has not actually stated. Leave a field null when unknown.
Then produce next_question: the single most natural next question to ask to fill the most important missing field, in a warm human Dubai-agent WhatsApp tone. If all three are known, next_question is null.`;

const SCHEMA: Anthropic.Tool.InputSchema = {
  type: "object",
  properties: {
    budget: { type: ["string", "null"] },
    area: { type: ["string", "null"] },
    requirement: { type: ["string", "null"] },
    next_question: { type: ["string", "null"] },
  },
  required: ["budget", "area", "requirement", "next_question"],
};

function transcript(messages: Message[]): string {
  return messages
    .map((m) => `${m.direction === "in" ? "Lead" : "Agent"}: ${m.body}`)
    .join("\n");
}

/** Extract budget/area/requirement + next question from the running convo. */
export async function qualify(messages: Message[]): Promise<Qualification> {
  const convo = transcript(messages);
  return structured<Qualification>(
    SYSTEM,
    `Conversation so far:\n${convo}`,
    SCHEMA,
  );
}
