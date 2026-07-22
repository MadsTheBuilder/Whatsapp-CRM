import { Router, type Request, type Response } from "express";
import {
  upsertLead,
  saveMessage,
  getMessages,
  getFacts,
  saveMemory,
  updateLeadQualification,
  type Stage,
} from "./store.js";
import { qualify } from "./qualify.js";
import { suggestReplies } from "./replies.js";
import { summarize, memoryBlock } from "./memory.js";
import { findMatchingListings, type ListingSummary } from "./listings.js";
import { makeBSP } from "./bsp/index.js";

const AGENT_ID = process.env.AGENT_ID ?? "agent_demo";

// One BSP for broker notifications (same seam server.ts uses for lead sends).
const bsp = makeBSP();

// Below this many messages the raw transcript is enough — no point compressing.
const SUMMARIZE_AFTER = 6;

// Once a summary exists, qualify/reply only need the recent turns — the summary
// carries the older context. Sending the whole transcript every turn is quadratic
// token cost on long threads.
const RECENT_WINDOW = 6;

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
  waId?: string,
): Promise<number> {
  const lead = upsertLead(AGENT_ID, phone, name);
  // Meta re-delivers the same wamid when we ack slowly; a duplicate is a no-op —
  // stop before re-qualifying and re-writing replies for a message we already have.
  if (!saveMessage(AGENT_ID, lead.id, "in", body, waId)) return lead.id;

  const messages = getMessages(AGENT_ID, lead.id);
  const inboundCount = messages.filter((m) => m.direction === "in").length;
  const stage = deriveStage(inboundCount);

  // Refresh long-term memory once the thread is long enough to be worth compressing,
  // then feed it back in so the agent writes the next message with what it remembers.
  // lead.* here is the PRIOR memory (lead was read before this inbound was saved).
  let memory: string;
  let recent = messages;
  if (messages.length >= SUMMARIZE_AFTER) {
    // Fold ONLY the messages since the last summary into the prior memory — the
    // old transcript is never re-read, so cost stays flat on long threads.
    const unseen = messages.filter((m) => m.id > lead.summary_upto);
    const prior = { summary: lead.summary ?? "", facts: getFacts(AGENT_ID, lead.id) };
    const mem = await summarize(unseen, prior);
    const upto = messages[messages.length - 1].id;
    saveMemory(AGENT_ID, lead.id, mem.summary, mem.facts, upto);
    // Use the memory we just computed, not lead.summary (a turn stale).
    memory = memoryBlock(mem.summary, mem.facts);
    // Summary now carries the old context, so qualify/reply only see recent turns.
    recent = messages.slice(-RECENT_WINDOW);
  } else {
    memory = memoryBlock(lead.summary, getFacts(AGENT_ID, lead.id));
  }

  const q = await qualify(recent, memory);

  // Fetch matching listings only on the turn qualification first completes.
  // A lead was already qualified before this turn iff it previously had all
  // three fields filled — a brand-new lead has next_question=null too (schema
  // default), so next_question alone can't tell "never asked" from "already done".
  const wasQualified = lead.budget !== null && lead.area !== null && lead.requirement !== null;
  let listings: ListingSummary[] = [];
  if (!wasQualified && q.next_question === null) {
    listings = await findMatchingListings(q);
  }

  const replies = await suggestReplies(recent, stage, memory, q, listings);

  updateLeadQualification(AGENT_ID, lead.id, {
    budget: q.budget,
    area: q.area,
    requirement: q.requirement,
    stage,
    next_question: q.next_question,
    replies,
  });

  // Push the lead's message + the 4 options to the broker's own WhatsApp so they
  // can copy one and forward it — no inbox web page needed. Off when AGENT_PHONE unset.
  const brokerPhone = process.env.AGENT_PHONE;
  if (brokerPhone) {
    const who = lead.name ? `${lead.name} (${phone})` : phone;
    const card =
      `New message from ${who}:\n"${body}"\n\n` +
      `Suggested replies:\n` +
      replies.filter(Boolean).map((r, i) => `${i + 1}. ${r}`).join("\n");
    // ponytail: fire-and-forget — a failed broker DM must not fail the inbound loop.
    bsp.send(brokerPhone, card).catch((e) =>
      console.error("broker notify failed:", e),
    );
  }

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
    // Meta queues inbound while the webhook is unreachable (ngrok down / URL
    // rotated) and flushes the backlog on reconnect — those arrive now but carry
    // their ORIGINAL send time. Drop anything older than STALE_MS so a previous
    // test session's messages don't reappear mid-conversation.
    // ponytail: fixed 10-min window; widen if a session legitimately goes quiet longer.
    const STALE_MS = 10 * 60 * 1000;
    const sentMs = Number(msg?.timestamp) * 1000;
    if (msg?.type === "text" && Date.now() - sentMs > STALE_MS) {
      console.warn(`webhook: dropping stale inbound (${msg.id}) sent ${new Date(sentMs).toISOString()}`);
    } else if (msg?.type === "text") {
      const phone = msg.from as string;
      const text = msg.text.body as string;
      const waId = msg.id as string | undefined;
      const name = entry?.contacts?.[0]?.profile?.name as string | undefined;
      await handleInbound(phone, text, name, waId);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("webhook error:", err);
    res.sendStatus(200); // Meta retries non-2xx; ack and log instead.
  }
});
