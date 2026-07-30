import { Router, type Request, type Response } from "express";
import { handleAgentMessage } from "../brain.js";
import { maybeRelayPortalLead } from "../portal/goyzer.js";
import { resolveAgentByReadNumber } from "../store.js";
import type { AgentMessageEvent } from "./types.js";

// This pipe READS the AGENT's own WhatsApp number via a SECOND 360dialog channel
// (coexistence: the number works in the normal WhatsApp app AND mirrors messages
// to us as webhooks — both lead→agent inbound AND the agent's own agent→lead sends).
// It feeds every text into the brain as a normalized AgentMessageEvent, the exact
// same shape the Baileys pipe emits. The brain never learns which pipe produced it.
//
// vs. the Baileys pipe: 360dialog gives real E.164 phones directly in BOTH
// directions, so the whole @lid recovery dance is gone — every event has
// lid:undefined and the brain's plain phone path handles it.
//
// vs. companyRouter (src/company.ts): that reads the COMPANY number (agent→bot Q&A,
// one direction). This reads the AGENT number (lead↔agent, both directions) and
// hands off to the brain, not to answerAgentQuestion. Different number, different
// 360dialog channel, so it needs its own webhook path (/agent-webhook).

// The bot's OWN number (the company/360dialog sender). When the agent number and
// the suggestion-target number are the SAME phone (single-agent setup: the bot reads
// Mitko's chats AND texts Mitko his cards), the bot's card — sent from this number to
// the agent — can land back on the agent channel's webhook as an inbound "message".
// Without this guard the brain would read its own card as a lead, qualify it, and DM
// another card: an infinite loop. Drop any chat with the bot's own number, both ways.
const COMPANY_BOT_NUMBER = process.env.COMPANY_BOT_NUMBER ?? "";

/**
 * Turn one 360dialog inbound/echo message into the brain's event shape, or null if
 * it isn't a lead text we should process (non-text, or missing a counterpart number).
 *
 * `readNumber` is the number this message arrived ON — the agent's own E.164 on
 * this channel, taken from the webhook's display_phone_number. We use it to tell
 * direction: a message whose `from` is the agent (== readNumber) is an agent→lead
 * send ("out"), anything else is a lead→agent message ("in"). On a coexistence echo
 * the lead (recipient) isn't in `msg.from`, so we take it from `recipientId` (read
 * off the accompanying status callback — see the POST handler).
 *
 * Pure transform: agentId/sendNumber are left blank here and stamped by the POST
 * handler once it has resolved the lane from readNumber (the store lookup is async
 * and doesn't belong in this pure shaper).
 */
export function toEvent(
  msg: {
    from?: string;
    id?: string;
    timestamp?: string | number;
    type?: string;
    text?: { body?: string };
  },
  contactName: string | undefined,
  readNumber: string | undefined,
  recipientId: string | undefined,
): AgentMessageEvent | null {
  if (msg?.type !== "text") return null; // media/interactive/etc. — text-only first cut
  const text = (msg.text?.body ?? "").trim();
  if (!text) return null;

  const from = msg.from ?? "";
  // Agent typed it (coexistence echo of their own send) → "out", lead is the
  // recipient. Otherwise the lead sent it → "in", lead is the sender.
  const isOut = readNumber !== undefined && from === readNumber;
  const leadNumber = isOut ? (recipientId ?? "") : from;
  if (!leadNumber) return null; // no counterpart number to key the lead on — drop

  // The bot's own card (from/to the bot number) is never a lead — drop it, or the
  // bot reads back its own suggestions and loops. Matters when agent==company number.
  if (COMPANY_BOT_NUMBER && leadNumber === COMPANY_BOT_NUMBER) return null;

  return {
    agentId: "", // stamped by the POST handler after resolving the lane
    sendNumber: "", // stamped by the POST handler after resolving the lane
    leadNumber, // real E.164 digits (no +), from 360dialog directly
    direction: isOut ? "out" : "in",
    text,
    timestamp: Number(msg.timestamp) * 1000, // 360dialog sends seconds
    waId: msg.id ?? undefined,
    leadName: contactName,
    lid: undefined, // 360dialog gives phones directly — no @lid resolution needed
  };
}

export const agentRouter = Router();

// GET verify: 360dialog/Meta handshake for the AGENT number's webhook. Echo
// hub.challenge when the token matches. Same shared token as the company webhook
// unless a per-number token is configured.
agentRouter.get("/agent-webhook", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const expected = process.env.AGENT_DIALOG360_VERIFY_TOKEN ?? process.env.DIALOG360_VERIFY_TOKEN;
  if (mode === "subscribe" && token === expected) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Resolve the lane, normalize, and hand to the brain. Runs AFTER the webhook has
// acked, so the brain's LLM work never delays the 200 — a slow brain used to let
// 360dialog retry and produce duplicate cards. Own errors logged, never thrown.
async function handleAgentWebhook(value: {
  metadata?: { display_phone_number?: string };
  messages?: unknown[];
  statuses?: { recipient_id?: string }[];
  contacts?: { profile?: { name?: string } }[];
}): Promise<void> {
  const msg = value?.messages?.[0] as Parameters<typeof toEvent>[0] | undefined;
  if (!msg) return; // status-only callback (delivery/read receipt), no message

  // The receiving number selects the lane. 360dialog mirrors Meta.
  const readNumber = value?.metadata?.display_phone_number;
  if (!readNumber) {
    console.log("[agent] drop: no display_phone_number in webhook");
    return;
  }
  const agent = await resolveAgentByReadNumber(readNumber);
  if (!agent) {
    console.log(`[agent] drop: unregistered number ${readNumber}`);
    return;
  }

  const recipientId = value?.statuses?.[0]?.recipient_id;
  const contactName = value?.contacts?.[0]?.profile?.name;

  const ev = toEvent(msg, contactName, readNumber, recipientId);
  if (!ev) return;
  ev.agentId = agent.agent_id; // stamp the lane resolved from the receiving number
  ev.sendNumber = agent.send_number;

  // A Goyzer lead-relay card (portal enquiry, not agent/lead chat) is handled
  // entirely here — three template sends + a force-approved seed row — and must
  // never reach the brain as an ordinary inbound message. Strict sender-gate: only a
  // card FROM the agent's goyzer_number relays; ev.leadNumber is the sender on an
  // inbound message (see toEvent). See src/portal/goyzer.ts.
  try {
    if (await maybeRelayPortalLead(agent, ev.text, ev.leadNumber)) return;
  } catch (e) {
    console.error("[agent] maybeRelayPortalLead failed:", e);
    return; // don't let a broken relay attempt fall through into the brain
  }

  console.log(
    `[agent] ${ev.direction} ${ev.leadNumber} (${ev.leadName ?? "?"}) → ${ev.agentId}: "${ev.text}" — handing to brain...`,
  );
  try {
    await handleAgentMessage(ev);
  } catch (e) {
    console.error("[agent] handleAgentMessage failed:", e);
  }
}

// Recently-processed message ids — dedupe provider retries so a re-POST can't drive
// the brain twice and DM a duplicate card. Bounded ring (one agent, low volume).
const seenAgentMsgIds = new Set<string>();
function alreadyHandledAgent(id: string | undefined): boolean {
  if (!id) return false;
  if (seenAgentMsgIds.has(id)) return true;
  seenAgentMsgIds.add(id);
  if (seenAgentMsgIds.size > 500) seenAgentMsgIds.delete(seenAgentMsgIds.values().next().value!);
  return false;
}

// POST receive: ACK IMMEDIATELY, then process. Brain work (LLM classify/summarize)
// used to run before the 200; a slow brain let 360dialog retry and duplicate cards.
agentRouter.post("/agent-webhook", (req: Request, res: Response) => {
  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  const msg = value?.messages?.[0];
  res.sendStatus(200); // ack FIRST
  // ponytail: diag — remove once the echo payload shape is confirmed live.
  console.log(`[agent:diag] body=${JSON.stringify(req.body).slice(0, 800)}`);
  if (msg && alreadyHandledAgent(msg.id)) return;
  handleAgentWebhook(value).catch((err) => console.error("agent-webhook handler error:", err));
});
