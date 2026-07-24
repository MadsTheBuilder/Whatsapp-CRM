import type Anthropic from "@anthropic-ai/sdk";
import { structured } from "./claude.js";
import type { Message } from "./store.js";

export interface Qualification {
  budget: string | null;
  area: string | null;
  requirement: string | null;
  deal_type: string | null; // rent | buy
  unit_type: string | null; // apartment | townhouse | villa | ...
  beds: string | null; // studio | 1BR | 2BR | ...
  timeline: string | null; // move-in / buy timing the lead stated ("November", "lease ends in 2 months")
  next_question: string | null;
}

// The model occasionally emits its chain-of-thought into `budget` instead of a
// value ("There is no concrete budget stated. I will record..."). A real budget is
// short and numeric-ish ("AED 80k/yr", "1.4M", "8k/month"); prose is long or reads
// like reasoning. Reject the latter → null so the next-question logic re-asks.
export function cleanBudget(budget: string | null): string | null {
  if (budget === null) return null;
  const b = budget.trim();
  if (b.length > 40) return null;
  if (/there is no|i will record|to maintain|assume|translates to|however/i.test(b)) return null;
  return b || null;
}

// The model extracts requirement as three sub-parts (transaction/property_type/
// bedrooms) so it can't fake a "complete" requirement from a half-statement.
// We recombine them into the single `requirement` string callers expect.
interface RawQualification {
  budget: string | null;
  area: string | null;
  transaction: string | null;
  property_type: string | null;
  bedrooms: string | null;
  timeline: string | null;
  uncertain: string[]; // which of budget/area/requirement were vague when captured
  next_question: string | null;
}

const SYSTEM = `You qualify real-estate leads for a Dubai property agent from a WhatsApp conversation. Your job is to extract only what the lead has ACTUALLY stated and to ask the one best next question. You are precise, not eager — a wrong value is worse than a null.

FIRST, decide if this is a genuine property inquiry. If the thread is only a greeting, spam, a wrong number, a "who is this?", or otherwise not someone looking to buy or rent property, set budget/area and all requirement sub-fields to null, set uncertain to [], and make next_question a warm, human re-engagement that gently finds out whether they're looking for a property (e.g. "Hi! Are you looking to buy or rent in Dubai? Happy to help 🙂"). Do not qualify a non-lead.

EXTRACTION — concrete values only. Record a field only when the lead has stated a concrete, actionable value. Never guess, never infer, never upgrade a vague hint into a value. When unsure, use null.
- budget: a real number or range (e.g. "1.4M AED", "around 2 million", "8k/month"). Vague words like "affordable", "cheap", "good deal" are NOT a budget → null.
- area: a named Dubai community or location (e.g. "JVC", "Dubai Marina", "Downtown"). Vague words like "near the water", "somewhere nice", "central" are NOT an area → null.
- requirement sub-fields:
  - transaction: "buy" or "rent" — only if the lead made this clear. null otherwise.
  - property_type: e.g. "off-plan apartment", "secondary villa", "townhouse". null if not stated.
  - bedrooms: e.g. "2BR", "studio", "3 bed". null if not stated.
- timeline: when the lead wants to move in or buy, ONLY if they stated it — a date/month ("November", "the 1st"), a horizon ("in a couple of months", "ASAP", "next year"), or a driver that implies timing ("my lease ends in October", "relocating in Q1"). Capture their own words. null if they've given no timing signal. Never ask for this — it's read passively from what they volunteer.

UNCERTAIN — for any of the three logical fields (budget, area, requirement) that you DID capture but where the lead's wording left real ambiguity (e.g. they said "2 mill-ish", or "the marina area" without which marina, or "probably buy"), add that field name ("budget" | "area" | "requirement") to the uncertain array. If a value was stated cleanly, do NOT list it. If a field is null, do NOT list it.

NEXT QUESTION — warm, human Dubai-agent WhatsApp tone, one thing at a time:
- If any of the three logical fields is still missing (null), ask about the single most important missing one. Priority when several are missing: budget → requirement → area.
- If all three are captured but some are in the uncertain array, next_question is a brief, friendly readback to confirm ONLY the uncertain field(s) (e.g. "Just to confirm — you're after around 2M AED, is that right?"). Do not re-ask fields that were stated cleanly.
- Only when all three are captured AND none are uncertain, set next_question to null (the lead is fully qualified).`;

const SCHEMA: Anthropic.Tool.InputSchema = {
  type: "object",
  properties: {
    budget: { type: ["string", "null"] },
    area: { type: ["string", "null"] },
    transaction: { type: ["string", "null"] },
    property_type: { type: ["string", "null"] },
    bedrooms: { type: ["string", "null"] },
    timeline: { type: ["string", "null"] },
    uncertain: { type: "array", items: { type: "string" } },
    next_question: { type: ["string", "null"] },
  },
  required: [
    "budget",
    "area",
    "transaction",
    "property_type",
    "bedrooms",
    "timeline",
    "uncertain",
    "next_question",
  ],
};

// "buy · off-plan apartment · 2BR" from whatever sub-parts are present; null if none.
function joinRequirement(r: RawQualification): string | null {
  const parts = [r.transaction, r.property_type, r.bedrooms].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function transcript(messages: Message[]): string {
  return messages
    .map((m) => `${m.direction === "in" ? "Lead" : "Agent"}: ${m.body}`)
    .join("\n");
}

/** Extract budget/area/requirement + next question from the running convo. */
export async function qualify(
  messages: Message[],
  memory = "",
): Promise<Qualification> {
  const convo = transcript(messages);
  const raw = await structured<RawQualification>(
    SYSTEM,
    `${memory}Conversation so far:\n${convo}`,
    SCHEMA,
  );
  return {
    budget: cleanBudget(raw.budget),
    area: raw.area,
    requirement: joinRequirement(raw),
    deal_type: raw.transaction,
    unit_type: raw.property_type,
    beds: raw.bedrooms,
    timeline: raw.timeline,
    next_question: raw.next_question,
  };
}
