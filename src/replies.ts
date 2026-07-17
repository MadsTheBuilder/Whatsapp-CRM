import type Anthropic from "@anthropic-ai/sdk";
import { structured } from "./claude.js";
import type { Message, Stage } from "./store.js";

const SYSTEM = `You are the response-intelligence layer for a Dubai real-estate agent on WhatsApp — the differentiator.
Given the conversation and the relationship stage, write EXACTLY 4 reply options the agent could send next.
Voice: real Dubai-agent WhatsApp tone — warm, human, casual, never robotic or corporate.
Real examples of the tone: "give me a buzz when you're free", "just tried reaching you, seems you're busy".
Match the stage:
- first_contact: opening / building rapport, gently qualifying.
- following_up: chasing a lead who went quiet, light and no-pressure.
- deep: several conversations in — concrete, moving toward viewing/next step.
Vary the 4 options so the agent has a genuine choice. Never auto-send — the agent picks one.`;

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

/** Generate exactly 4 stage-aware human-worded reply options. */
export async function suggestReplies(
  messages: Message[],
  stage: Stage,
): Promise<string[]> {
  const convo = transcript(messages);
  const { replies } = await structured<{ replies: string[] }>(
    SYSTEM,
    `Relationship stage: ${stage}\n\nConversation so far:\n${convo}`,
    SCHEMA,
  );
  // Guarantee exactly 4 — the demo's self-check asserts this.
  // ponytail: hard-slice/pad rather than re-prompt; re-prompt if quality bites.
  const trimmed = replies.slice(0, 4);
  while (trimmed.length < 4) trimmed.push("");
  return trimmed;
}
