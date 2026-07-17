import { Router, type Request, type Response } from "express";
import {
  upsertLead,
  saveMessage,
  getMessages,
  updateLeadQualification,
  type Stage,
} from "./store.js";
import { qualify } from "./qualify.js";
import { suggestReplies } from "./replies.js";

const AGENT_ID = process.env.AGENT_ID ?? "agent_demo";

/** Relationship stage from how many inbound messages we've seen from this lead. */
function deriveStage(inboundCount: number): Stage {
  if (inboundCount <= 1) return "first_contact";
  if (inboundCount <= 3) return "following_up";
  return "deep";
}

/**
 * Core Stage-1 loop: store inbound → qualify → generate 4 replies → cache on lead.
 * Shared by the live webhook and scripts/simulate.ts. Returns the lead id.
 */
export async function handleInbound(
  phone: string,
  body: string,
  name?: string,
): Promise<number> {
  const lead = upsertLead(AGENT_ID, phone, name);
  saveMessage(AGENT_ID, lead.id, "in", body);

  const messages = getMessages(AGENT_ID, lead.id);
  const inboundCount = messages.filter((m) => m.direction === "in").length;
  const stage = deriveStage(inboundCount);

  const q = await qualify(messages);
  const replies = await suggestReplies(messages, stage);

  updateLeadQualification(AGENT_ID, lead.id, {
    budget: q.budget,
    area: q.area,
    requirement: q.requirement,
    stage,
    next_question: q.next_question,
    replies,
  });

  return lead.id;
}

// --- Meta Cloud API webhook shape (same as 360dialog production) ---

export const webhookRouter = Router();

// GET verify: Meta handshake. Echo hub.challenge when the verify token matches.
webhookRouter.get("/webhook", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// POST receive: parse sender/text and run the loop. Ack fast; work is inline.
// ponytail: synchronous Claude call in the request — move to a job if latency bites.
webhookRouter.post("/webhook", async (req: Request, res: Response) => {
  try {
    const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = entry?.messages?.[0];
    if (msg?.type === "text") {
      const phone = msg.from as string;
      const text = msg.text.body as string;
      const name = entry?.contacts?.[0]?.profile?.name as string | undefined;
      await handleInbound(phone, text, name);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("webhook error:", err);
    res.sendStatus(200); // Meta retries non-2xx; ack and log instead.
  }
});
