import type Anthropic from "@anthropic-ai/sdk";
import { structured, REPLY_MODEL } from "./claude.js";
import {
  getInterviewState,
  setInterviewState,
  saveVoiceCard,
  maxOutboundId,
  type InterviewState,
} from "./store.js";

// Layer 2C: the voice-onboarding interview, run INSIDE WhatsApp on the company
// number. The bot plays a series of pre-scripted leads at the agent; the agent
// replies as themselves; at the end the model extrapolates a voice card. Ported
// from the voice-extraction-role-play SKILL — same 12 scenarios, same card format
// as distill.ts, so the seed and the distill loop stay compatible.
//
// The scenarios are FIXED text (no LLM per turn) — the bot just walks the list.
// Only the final card extraction calls the model. State lives on
// agent_persona.interview_state; this module is pure interview logic, wired into
// company.ts's text branch.

// Each scenario = the lead message the bot sends. Order matters: the first 4 cover
// the core voice dimensions (per the skill). Kept tight for WhatsApp bubbles.
const SCENARIOS: { setup: string; message: string }[] = [
  {
    setup: "Abu — cash ready, wants to close on a 2BR in Jumeirah within a month:",
    message:
      "Hi, I've got cash ready and want to close on a 2BR in Jumeirah within a month. What's available in the 3-4M range? Can we do a viewing this week?",
  },
  {
    setup: "Sarah — just browsing, no budget or timeline:",
    message:
      "Hey! Just browsing for fun 😊 what kind of apartments do you have? Nothing specific, just curious what's out there.",
  },
  {
    setup: "Hassan — upset, last 5 viewings didn't match, threatening to leave:",
    message:
      "This is ridiculous. You showed me 5 places and none were close to what I said. I want a refund of the viewing fees or I'm going to another agent.",
  },
  {
    setup: "Fatima — was interested in JVC, silent for 2 weeks. YOU initiate. Write a follow-up to check in:",
    message: "(she hasn't messaged — what do you send her?)",
  },
  {
    setup: "Ravi — keen on a 1.9M apartment but pushing hard on price and your fee:",
    message:
      "The price is way too high for that building, and 2% commission on top is a lot. Can you get the seller down, or cut your fee? Otherwise I'll keep looking.",
  },
  {
    setup: "Mei — says another agent quoted the same unit cheaper:",
    message:
      "Another agent showed me the exact same unit and said he can do it cheaper. Why should I go with you? What can you actually do that he can't?",
  },
  {
    setup: "Karan — viewed a townhouse 2 days ago, seemed to love it, then went silent. YOU initiate:",
    message: "(he's gone quiet after the viewing — what message do you send him?)",
  },
  {
    setup: "Yousef — first-time buyer, wary of agents:",
    message:
      "How do I even know you're legit and not just chasing your commission? Every agent says the same things. Convince me you're different.",
  },
  {
    setup: "Deepa — ready to sign on a 2.4M unit, but wants a private kickback:",
    message:
      "Look, I'll sign today if you give me 1% back from your commission, cash, between us. Every agent does it. Deal?",
  },
  {
    setup: "James — in London, never been to Dubai, nervous about buying remotely:",
    message:
      "I've never been to Dubai and I'd be buying entirely remotely. How does the process work — payment, paperwork, handover? Is it safe to do from abroad?",
  },
  {
    setup: "Priya — excited, messaged 5 times in an hour, expects instant answers:",
    message:
      "Hi did you get my last message?? 🙏 Sorry to keep messaging! Just really excited. Can you send everything you have right now? Also can we view today? And is the price negotiable? And parking?",
  },
  {
    setup: "Omar — sends bare, clipped messages:",
    message: "villa? price?",
  },
];

export const TOTAL_SCENARIOS = SCENARIOS.length;

// The card format — MUST match distill.ts CARD_FORMAT so the distill loop can fold
// onto this seed without reshaping it.
const CARD_FORMAT = `VOICE (from onboarding):
- length/rhythm: <1 line>
- vocabulary & language mix: <1 line>
- emoji & punctuation: <1 line>
- greeting/sign-off: <1 line>
- warmth vs pressure: <1 line>
- objection/sales moves: <1 line>
- money & ethics: <1 line>
- signature quirks: <1 line>
Real examples: <3-4 of the agent's own replies, verbatim in style, private specifics scrubbed>
Never: <2-3 negative-space rules>`;

const EXTRACT_SYSTEM = `You are a forensic communication analyst. Below are real WhatsApp replies a Dubai real-estate agent gave to a series of role-play leads (each reply is paired with the lead scenario it answered). Extrapolate a VOICE CARD another writer could use to send new messages a lead would believe came from THIS agent, not a bot.

Output the EXACT format below — same lines, same order:

${CARD_FORMAT}

Rules:
1. Extrapolate every line ONLY from what the agent actually wrote. Do not invent traits they didn't show. If a dimension never came up, mark that line "not observed" — never guess.
2. PRIVACY. The card is prepended to every future reply prompt. In "Real examples:", preserve the agent's exact wording STYLE but replace private specifics — names, prices, phone numbers, buildings, areas — with placeholders like [name], [price], [area].
3. FIDELITY. Do NOT make the card more polished than the agent. Do NOT generalize toward generic sales-bot language. Preserve their actual texture — brevity, dry humor, typos, absence of emoji — warts included.

Keep it tight — it rides in every reply prompt.`;

const SCHEMA: Anthropic.Tool.InputSchema = {
  type: "object",
  properties: { voice_card: { type: "string" } },
  required: ["voice_card"],
};

/** The bot message that presents scenario `step` (0-based). Includes progress. */
function scenarioPrompt(step: number): string {
  const s = SCENARIOS[step];
  return `Lead ${step + 1} of ${TOTAL_SCENARIOS} — ${s.setup}\n\n"${s.message}"\n\nReply exactly as you would on WhatsApp right now — your real words, no editing.`;
}

/** The opener when the agent consents. Intro + first scenario. */
export function interviewIntro(): string {
  return (
    `Great — I'll play ${TOTAL_SCENARIOS} different leads. Reply to each exactly as you would on WhatsApp right now: your real words, no editing. There's no right answer — I'm just learning your voice.\n\n` +
    scenarioPrompt(0)
  );
}

/**
 * Advance the interview by one captured reply. Returns the bot's next message, and
 * whether the interview just finished (so the caller can extract+save the card).
 * Pure state transition — persistence and extraction are the caller's job.
 */
export function advance(
  state: InterviewState,
  reply: string,
): { next: InterviewState | null; botMessage: string; done: boolean } {
  const replies = [...state.replies, reply.trim()];
  const nextStep = state.step + 1;
  if (nextStep >= TOTAL_SCENARIOS) {
    // All done — hand the transcript back for extraction. Clear state (null).
    return {
      next: null,
      botMessage: `That's all ${TOTAL_SCENARIOS}. Building your voice card from your replies — one moment...`,
      done: true,
    };
  }
  return {
    next: { phase: "interviewing", step: nextStep, replies },
    botMessage: scenarioPrompt(nextStep),
    done: false,
  };
}

/** Extract the voice card from the captured replies (paired with their scenarios). */
export async function extractCard(replies: string[]): Promise<string> {
  const transcript = replies
    .map((r, i) => `Lead: ${SCENARIOS[i]?.setup ?? "?"}\nAgent replied: ${r}`)
    .join("\n\n");
  const { voice_card } = await structured<{ voice_card: string }>(
    EXTRACT_SYSTEM,
    transcript,
    SCHEMA,
    REPLY_MODEL, // voice-critical — use the bigger reply model
  );
  return (voice_card ?? "").trim();
}

/**
 * Handle one agent text while an interview is (or may be) in progress. Returns the
 * bot's reply string, or null if there's no active interview (→ caller falls through
 * to Q&A). This is the single entry point company.ts calls before Q&A.
 *
 * `agentId` scopes all state; `text` is the agent's raw message.
 */
export async function handleInterviewText(
  agentId: string,
  text: string,
): Promise<string | null> {
  const state = await getInterviewState(agentId);
  if (!state) return null; // no interview → not ours

  if (state.phase === "awaiting_consent") {
    // Typed consent (button path handled separately in company.ts). Accept a yes-ish
    // word to start; anything else cancels the offer so it can't trap Q&A.
    if (/^\s*(yes|y|ok|okay|sure|start|go)\s*$/i.test(text)) {
      await setInterviewState(agentId, { phase: "interviewing", step: 0, replies: [] });
      return interviewIntro();
    }
    await setInterviewState(agentId, null); // declined → drop the offer, back to normal
    return "No problem — I'll keep suggesting replies as usual. Say \"voice\" anytime to teach me your style.";
  }

  // phase === "interviewing": capture this reply and advance.
  const { next, botMessage, done } = advance(state, text);
  if (done) {
    // Extract + save, then clear state. On any failure, clear state so the agent
    // isn't trapped mid-interview — worst case they just re-run it.
    try {
      const card = await extractCard([...state.replies, text.trim()]);
      const upto = await maxOutboundId(agentId);
      await saveVoiceCard(agentId, card, upto, {
        fromUpto: 0,
        sampleCount: TOTAL_SCENARIOS,
      });
      await setInterviewState(agentId, null);
      return `${botMessage}\n\n✓ Done. My suggestions will now sound like you. I'll keep sharpening it from your real replies over time.`;
    } catch (e) {
      console.error("[voice-interview] extract/save failed:", e);
      await setInterviewState(agentId, null);
      return "Something went wrong building your card — no changes made. Say \"voice\" to try again.";
    }
  }
  await setInterviewState(agentId, next);
  return botMessage;
}

/** Begin the interview offer (state = awaiting_consent). Caller sends the offer card. */
export async function offerInterview(agentId: string): Promise<void> {
  await setInterviewState(agentId, { phase: "awaiting_consent", step: 0, replies: [] });
}
