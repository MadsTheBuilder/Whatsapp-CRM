import type Anthropic from "@anthropic-ai/sdk";
import { structured, REPLY_MODEL } from "./claude.js";
import {
  getVoiceCardState,
  saveVoiceCard,
  unfoldedAgentSamples,
} from "./store.js";

// Layer 2B: fold the agent's real hand-sent messages onto the voice card so it
// tracks how they actually write over time. Mirrors memory.ts summarize(): prior
// card + only NEW messages in, updated card out — the old transcript is never
// re-read. Gated by DISTILL_THRESHOLD, triggered fire-and-forget from brain.ts.

// New hand-sent messages (since card_upto) needed before a distill runs. Env
// override for prototype testing — set DISTILL_THRESHOLD=4 in .env to fire after a
// handful of live messages, delete the line to restore the default 20.
export const DISTILL_THRESHOLD = Number(process.env.DISTILL_THRESHOLD) || 20;

// The exact card format the role-play seed uses. Kept literal so the model
// preserves the shape when it folds (must match SKILL.md "Card format").
const CARD_FORMAT = `VOICE (from onboarding):
- length/rhythm: <1 line>
- vocabulary & language mix: <1 line>
- emoji & punctuation: <1 line>
- greeting/sign-off: <1 line>
- warmth vs pressure: <1 line>
- objection/sales moves: <1 line>
- money & ethics: <1 line>
- signature quirks: <1 line>
Real examples: <3-4 of the agent's own messages, verbatim in style, private specifics scrubbed>
Never: <2-3 negative-space rules>`;

const SYSTEM = `You maintain a voice card describing how THIS Dubai real-estate agent writes on WhatsApp. You are given the card SO FAR and only NEW real messages the agent hand-sent since the card was last updated. Fold the new messages in: sharpen traits the new messages confirm, correct traits they contradict, add a newly-visible habit, drop nothing that's still true. If there is no prior card, build one from the messages alone.

Keep the EXACT section format below — same lines, same order:

${CARD_FORMAT}

Update the "Real examples:" block to the strongest 3-4 messages (prefer newer, most characteristic ones).

Two hard rules:
1. PRIVACY. The card is prepended to every future reply prompt. In "Real examples:", preserve the agent's exact wording STYLE but replace private specifics — names, prices, phone numbers, building/area names, deal facts — with placeholders like [name], [price], [area], [building]. No real lead data may appear in the card.
2. FIDELITY. Do NOT make the card more polished than the agent. Do NOT generalize toward generic sales-bot language. Do NOT remove awkward-but-consistent traits (brevity, dry humor, typos, absence of emoji). The whole point is preserving the agent's actual WhatsApp texture, warts included.

Keep it tight — it rides in every reply prompt.`;

const SCHEMA: Anthropic.Tool.InputSchema = {
  type: "object",
  properties: { voice_card: { type: "string" } },
  required: ["voice_card"],
};

/** Fold new real messages onto the prior card. One string in, one string out —
 *  the whole card is text, no per-field JSON (matches the seed's text format). */
export async function distillVoiceCard(
  priorCard: string,
  newSamples: string[],
): Promise<string> {
  const priorBlock = priorCard.trim()
    ? `Card so far:\n${priorCard.trim()}\n\n`
    : "";
  const messages = newSamples.map((m) => `- ${m}`).join("\n");
  const { voice_card } = await structured<{ voice_card: string }>(
    SYSTEM,
    `${priorBlock}New real messages the agent sent since then:\n${messages}`,
    SCHEMA,
    REPLY_MODEL, // voice-critical, like suggestReplies — use the bigger model
  );
  return (voice_card ?? "").trim();
}

// In-flight guard: the threshold-on-send trigger can fire again before the first
// save advances card_upto; the guard drops the duplicate so we don't double-fold.
// ponytail: in-memory Set, fine for one process/one agent. Move to a DB advisory
// lock (or the CAS-on-card_upto write) when a second instance can distill the
// same agent concurrently — deferred per the plan.
const inFlight = new Set<string>();

/** Read watermark → count unseen → if < threshold, no-op → else fold + save.
 *  Returns true if a distill actually ran. Emits one structured log line per
 *  invocation (observability): the fire-and-forget trigger swallows the result,
 *  so this log is the only window into the loop. */
export async function maybeDistillVoiceCard(agentId: string): Promise<boolean> {
  if (inFlight.has(agentId)) {
    console.log(`[distill] ${agentId} skipped: already in flight`);
    return false;
  }
  inFlight.add(agentId);
  try {
    const { card, upto } = await getVoiceCardState(agentId);
    const { samples, capped } = await unfoldedAgentSamples(agentId, upto);

    if (samples.length < DISTILL_THRESHOLD) {
      console.log(
        `[distill] ${agentId} skipped: ${samples.length}/${DISTILL_THRESHOLD} new (fromUpto=${upto})`,
      );
      return false;
    }

    const updated = await distillVoiceCard(card, samples.map((s) => s.body));
    const newUpto = samples[samples.length - 1].id;
    await saveVoiceCard(agentId, updated, newUpto, {
      fromUpto: upto,
      sampleCount: samples.length,
    });
    console.log(
      `[distill] ${agentId} saved: folded ${samples.length} msgs, ${upto}→${newUpto}${capped ? " (batch capped, more remain)" : ""}`,
    );
    return true;
  } catch (e) {
    console.error(`[distill] ${agentId} failed:`, e);
    return false;
  } finally {
    inFlight.delete(agentId);
  }
}
