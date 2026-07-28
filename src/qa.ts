import type Anthropic from "@anthropic-ai/sdk";
import { structured } from "./claude.js";
import { listLeads, getFacts, responsiveness, type Lead } from "./store.js";

// A lead counts as qualified once all three fields are known (same rule the brain
// uses to decide qualification is complete — see brain.ts wasQualified).
export function isQualified(l: Lead): boolean {
  return l.budget !== null && l.area !== null && l.requirement !== null;
}

// Match a lead by the name/needle the agent typed — case-insensitive substring on
// name, or exact/suffix match on phone digits. Loose on purpose: the agent types
// "Ahmed", not a normalized key.
export function findLead(leads: Lead[], needle: string): Lead | undefined {
  const n = needle.trim().toLowerCase();
  if (!n) return undefined;
  const digits = n.replace(/\D/g, "");
  return leads.find(
    (l) =>
      (l.name && l.name.toLowerCase().includes(n)) ||
      (digits.length >= 4 && l.phone.replace(/\D/g, "").endsWith(digits)),
  );
}

interface Intent {
  intent: "count_leads" | "count_qualified" | "count_no_reply" | "summarize_lead" | "unknown";
  lead: string | null; // the name/number for summarize_lead, else null
}

const SYSTEM = `You classify a single WhatsApp message that a Dubai real-estate agent sent to their assistant bot. Pick the ONE intent that matches, and if they named a specific lead, extract that name or number.

Intents:
- count_leads: how many leads / how many people am I working on (total).
- count_qualified: how many are qualified / have budget+area+requirement / ready.
- count_no_reply: how many haven't replied / have gone silent / need chasing.
- summarize_lead: anything about ONE named lead — "summarize Ahmed", "what's the deal with +971...", "where are we with Sara". Put the name or number in "lead".
- unknown: anything else (greetings, unrelated, unclear).

Only set "lead" for summarize_lead; otherwise null.`;

const SCHEMA: Anthropic.Tool.InputSchema = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: ["count_leads", "count_qualified", "count_no_reply", "summarize_lead", "unknown"],
    },
    lead: { type: ["string", "null"] },
  },
  required: ["intent", "lead"],
};

const HELP =
  "I can tell you: how many leads you're working on, how many are qualified, " +
  "how many haven't replied, or a summary of one lead (e.g. \"summarize Ahmed\").";

/**
 * Answer an on-demand question the agent texted the company number. Classify the
 * intent with the LLM, then answer straight from the store — no NLU framework.
 * ponytail: LLM intent + direct store queries; enum is small on purpose.
 */
export async function answerAgentQuestion(agentId: string, text: string): Promise<string> {
  const { intent, lead: needle } = await structured<Intent>(SYSTEM, text, SCHEMA);
  const leads = await listLeads(agentId);

  switch (intent) {
    case "count_leads":
      return `You're working on ${leads.length} lead${leads.length === 1 ? "" : "s"}.`;

    case "count_qualified": {
      const n = leads.filter(isQualified).length;
      return `${n} of your ${leads.length} lead${leads.length === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} qualified (budget, area, and requirement all known).`;
    }

    case "count_no_reply": {
      const states = await Promise.all(
        leads.map((l) => responsiveness(agentId, l.id).then((r) => r.state)),
      );
      const n = states.filter((s) => s === "no_reply").length;
      return `${n} lead${n === 1 ? "" : "s"} ${n === 1 ? "has" : "have"} gone quiet with no reply.`;
    }

    case "summarize_lead": {
      const found = needle ? findLead(leads, needle) : undefined;
      if (!found) return `I couldn't find a lead matching "${needle ?? ""}".`;
      const facts = await getFacts(agentId, found.id);
      const who = found.name ? `${found.name} (${found.phone})` : found.phone;
      const summary = found.summary?.trim() || "No summary yet.";
      const factLines = facts.length ? "\n\nFacts:\n" + facts.map((f) => `• ${f}`).join("\n") : "";
      return `${who}\n\n${summary}${factLines}`;
    }

    default:
      return HELP;
  }
}
