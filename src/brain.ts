import {
  findLeadByPhone,
  createPendingLead,
  saveMessage,
  getMessages,
  getFacts,
  saveMemory,
  updateLeadQualification,
  type Lead,
  type Stage,
} from "./store.js";
import { qualify } from "./qualify.js";
import { suggestReplies } from "./replies.js";
import { summarize, memoryBlock } from "./memory.js";
import { findMatchingListings, type ListingSummary } from "./listings.js";
import { notifyAgent, askApproval } from "./notify.js";
import type { AgentMessageEvent } from "./pipe/types.js";

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
 * Core Stage-1 loop, pipe-agnostic: one normalized event in, store it, and —
 * only when the LEAD spoke (direction "in") — qualify → summarize → 4 replies →
 * DM the agent a suggestion card. An agent-sent message (direction "out") is
 * stored for transcript/summary continuity and resets responsiveness, but never
 * generates a suggestion (the agent doesn't need a reply to their own message).
 * Returns the lead id.
 */
export async function handleAgentMessage(ev: AgentMessageEvent): Promise<number> {
  // Approval gate (Dennis/Mitko problem): the read-pipe sees EVERY 1:1 chat, so a
  // colleague texting the agent lands here too. Only agent-approved numbers are
  // processed. A brand-new number is prompted once (Yes/No buttons on the company
  // number) and its message DROPPED — pending/rejected numbers drop silently too,
  // nothing is stored, until the agent approves. This is the pipe-agnostic seam,
  // so 360dialog gets the same gate for free when it replaces Baileys.
  let lead: Lead | undefined = await findLeadByPhone(ev.agentId, ev.leadNumber);
  if (!lead) {
    // First sighting: remember it as pending and ask the agent. Don't store the
    // message — buffering is out (decision: drop until approved).
    const { lead: created, created: didCreate } = await createPendingLead(
      ev.agentId,
      ev.leadNumber,
      ev.leadName,
    );
    // Fire the prompt only for the message that actually created the row, so a
    // race (two messages arriving before either inserts) prompts the agent once.
    if (didCreate) {
      askApproval(ev.leadNumber, ev.leadName).catch((e) =>
        console.error("askApproval failed:", e),
      );
    }
    return created.id;
  }
  if (lead.monitor !== "approved") return lead.id; // pending or rejected — drop.

  // A provider re-delivers the same waId on a slow ack; a duplicate is a no-op —
  // stop before re-qualifying and re-writing replies for a message we already have.
  if (!(await saveMessage(ev.agentId, lead.id, ev.direction, ev.text, ev.waId))) {
    return lead.id;
  }

  // The agent's own reply is stored (above) but needs no suggestion.
  if (ev.direction === "out") return lead.id;

  const messages = await getMessages(ev.agentId, lead.id);
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
    const prior = { summary: lead.summary ?? "", facts: await getFacts(ev.agentId, lead.id) };
    const mem = await summarize(unseen, prior);
    const upto = messages[messages.length - 1].id;
    await saveMemory(ev.agentId, lead.id, mem.summary, mem.facts, upto);
    // Use the memory we just computed, not lead.summary (a turn stale).
    memory = memoryBlock(mem.summary, mem.facts);
    // Summary now carries the old context, so qualify/reply only see recent turns.
    recent = messages.slice(-RECENT_WINDOW);
  } else {
    memory = memoryBlock(lead.summary, await getFacts(ev.agentId, lead.id));
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

  await updateLeadQualification(ev.agentId, lead.id, {
    budget: q.budget,
    area: q.area,
    requirement: q.requirement,
    stage,
    next_question: q.next_question,
    replies,
  });

  // Privately DM the agent the lead's message + the 4 options so they can copy one
  // and send it themselves. Goes to the agent on the company number — never the lead.
  const who = lead.name ? `${lead.name} (${ev.leadNumber})` : ev.leadNumber;
  const card =
    `New message from ${who}:\n"${ev.text}"\n\n` +
    `Suggested replies:\n` +
    replies.filter(Boolean).map((r, i) => `${i + 1}. ${r}`).join("\n");
  // ponytail: fire-and-forget — a failed agent DM must not fail the inbound loop.
  notifyAgent(card).catch((e) => console.error("notifyAgent failed:", e));

  return lead.id;
}
