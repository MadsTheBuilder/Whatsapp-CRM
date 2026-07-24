import {
  findLeadByPhone,
  findLeadByLid,
  setLeadLid,
  createPendingLead,
  saveMessage,
  getMessages,
  getFacts,
  saveMemory,
  updateLeadQualification,
  recentAgentSamples,
  getVoiceCard,
  type Lead,
  type Stage,
} from "./store.js";
import { qualify } from "./qualify.js";
import { suggestReplies } from "./replies.js";
import { summarize, memoryBlock } from "./memory.js";
import { findMatchingListings, type ListingSummary } from "./listings.js";
import { notifyAgent, askApproval, askStage } from "./notify.js";
import { maybeDistillVoiceCard } from "./distill.js";
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
  // A lid-only message (outbound @lid) has no phone — leadNumber is the lid
  // digits. Resolve by lid instead; the link was learned from an earlier inbound.
  const lidOnly = ev.lid !== undefined && ev.leadNumber === ev.lid;
  let lead: Lead | undefined = lidOnly
    ? await findLeadByLid(ev.agentId, ev.lid!)
    : await findLeadByPhone(ev.agentId, ev.leadNumber);
  if (!lead) {
    // Cold outbound to a never-seen @lid contact: no phone to show the agent and
    // no inbound to anchor it — drop silently, don't create a pending prompt.
    if (lidOnly) {
      console.log(`[brain] drop lid=${ev.lid}: outbound to unlinked @lid contact`); // ponytail: diag
      return 0;
    }
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
  // Learn the lid↔phone link: an inbound @lid message carries both. Store the lid
  // on the lead (only if unset) so the next outbound @lid resolves back to it.
  if (!lidOnly && ev.lid && !lead.lid) {
    setLeadLid(ev.agentId, lead.id, ev.lid).catch((e) => console.error("setLeadLid failed:", e));
  }
  if (lead.monitor !== "approved") {
    console.log(`[brain] drop ${ev.leadNumber}: monitor=${lead.monitor} (not approved)`); // ponytail: diag
    return lead.id; // pending or rejected — drop.
  }

  // A provider re-delivers the same waId on a slow ack; a duplicate is a no-op —
  // stop before re-qualifying and re-writing replies for a message we already have.
  if (!(await saveMessage(ev.agentId, lead.id, ev.direction, ev.text, ev.waId))) {
    console.log(`[brain] drop ${ev.leadNumber}: duplicate waId=${ev.waId}`); // ponytail: diag
    return lead.id;
  }

  // The agent's own reply is stored (above) but needs no suggestion.
  if (ev.direction === "out") {
    console.log(`[brain] stored out-msg for ${ev.leadNumber}, no card (agent's own reply)`); // ponytail: diag
    // Threshold-driven voice-card refresh from the agent's real messages. Fire-
    // and-forget: a slow/failed distill must never touch the read-pipe. Guarded +
    // gated by DISTILL_THRESHOLD inside, so most calls are a cheap count-and-skip.
    maybeDistillVoiceCard(ev.agentId).catch((e) => console.error("distill failed:", e));
    return lead.id;
  }
  console.log(`[brain] ${ev.leadNumber} approved+saved — generating card...`); // ponytail: diag

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

  // Layer 3: mirror the agent's own voice. Agent-wide (voice isn't per-lead),
  // pulled fresh each reply. Empty for a brand-new agent → generic voice fallback.
  const voiceCard = await getVoiceCard(ev.agentId);
  const samples = await recentAgentSamples(ev.agentId);
  const replies = await suggestReplies(recent, stage, memory, q, listings, voiceCard, samples);

  await updateLeadQualification(ev.agentId, lead.id, {
    budget: q.budget,
    area: q.area,
    requirement: q.requirement,
    deal_type: q.deal_type,
    unit_type: q.unit_type,
    beds: q.beds,
    timeline: q.timeline,
    stage,
    next_question: q.next_question,
    replies,
  });

  // On the turn the 5 qualification criteria first fill up, DM the agent a list
  // message to set the funnel stage — the agent taps, never a silent auto-move.
  // Fields are sticky (null keeps prior), so the effective value is q.x ?? lead.x.
  // Fires once: `wasFull` false + `nowFull` true only on the completing turn, and
  // only while still `new` (a lead moved off `new` never gets re-prompted). No
  // separate "already asked" flag needed — same trick as the listings fetch above.
  const full = (o: { budget: string | null; area: string | null; deal_type: string | null; unit_type: string | null; beds: string | null }) =>
    o.budget !== null && o.area !== null && o.deal_type !== null && o.unit_type !== null && o.beds !== null;
  const wasFull = full(lead);
  const merged = {
    budget: q.budget ?? lead.budget,
    area: q.area ?? lead.area,
    deal_type: q.deal_type ?? lead.deal_type,
    unit_type: q.unit_type ?? lead.unit_type,
    beds: q.beds ?? lead.beds,
  };
  if (!wasFull && full(merged) && lead.pipeline === "new") {
    const qualLine = [merged.deal_type, merged.beds, merged.area, merged.budget]
      .filter(Boolean)
      .join(" · ");
    askStage(ev.leadNumber, lead.name, qualLine).catch((e) =>
      console.error("askStage failed:", e),
    );
  }

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
