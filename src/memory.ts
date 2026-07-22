import type Anthropic from "@anthropic-ai/sdk";
import { structured } from "./claude.js";
import type { Message } from "./store.js";

export interface Memory {
  summary: string;
  facts: string[];
}

const SYSTEM = `You maintain the long-term memory a Dubai real-estate agent keeps on a WhatsApp lead.
You are given the memory SO FAR (a previous summary + facts) and only the NEW messages since it was written. Fold the new messages into the memory: update what changed, add what's new, drop nothing important that's still true. Do not lose earlier context just because those messages aren't shown — the previous summary already holds it. If there is no previous memory, build it from the messages alone. Produce:

- summary: a rich 3-5 sentence brief the agent reads to walk back into this deal cold. Cover, in prose: who they are and what they're really after (not just the raw budget/area — the *intent* behind it: end-use vs investment, timeline, how firm or exploratory they are), how their thinking has shifted over the chat (e.g. moved from JVC to Marina and back), their current tone and how the last exchange left things, and the single most useful next move for the agent. Present tense, specific, no filler. A one-line summary is a failure — give real context.

- facts: durable, self-contained facts worth carrying into future chats. Each fact must stand on its own and carry meaning — write "Wants a 2BR, budget ~1.4M AED" as ONE fact, not "2BR" and "1.4M" and "Marina" as three fragments. Fragmented single-word facts are useless; combine related details into one clear statement. Capture: what they want and why, hard constraints and preferences, objections or hesitations, personal context (family, timeline, job), any promise the agent made ("agent promised to send the JVC floor plan"), and shifts in position. No duplicates. Skip anything that just restates a single budget/area field with no added context.`;

const SCHEMA: Anthropic.Tool.InputSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    facts: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "facts"],
};

function transcript(messages: Message[]): string {
  return messages
    .map((m) => `${m.direction === "in" ? "Lead" : "Agent"}: ${m.body}`)
    .join("\n");
}

/** Fold new messages into the existing memory. Pass the prior summary + facts and
 *  ONLY the messages written since that summary — the old transcript is never re-read. */
export async function summarize(
  newMessages: Message[],
  prior: Memory = { summary: "", facts: [] },
): Promise<Memory> {
  const priorBlock =
    prior.summary || prior.facts.length
      ? `Memory so far:\nSummary: ${prior.summary}\nFacts:\n${prior.facts.map((f) => `- ${f}`).join("\n")}\n\n`
      : "";
  const { summary, facts } = await structured<Memory>(
    SYSTEM,
    `${priorBlock}New messages since then:\n${transcript(newMessages)}`,
    SCHEMA,
  );
  return { summary: summary ?? "", facts: Array.isArray(facts) ? facts : [] };
}

/** Render stored memory as a prompt block, or "" when there's nothing yet. */
export function memoryBlock(summary: string | null, facts: string[]): string {
  if (!summary && facts.length === 0) return "";
  const factLines = facts.length ? "\n" + facts.map((f) => `- ${f}`).join("\n") : "";
  return `What you remember about this lead:\n${summary ?? ""}${factLines}\n\n`;
}
