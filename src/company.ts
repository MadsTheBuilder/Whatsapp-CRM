import { Router, type Request, type Response } from "express";
import { answerAgentQuestion } from "./qa.js";
import { notifyAgent, askVoiceConsent } from "./notify.js";
import { addOptOut } from "./optout.js";
import {
  handleInterviewText,
  interviewIntro,
  offerInterview,
} from "./voice-interview.js";
import { setInterviewState, getInterviewState, getVoiceCard } from "./store.js";
import {
  setMonitor,
  setPipeline,
  findLeadByPhone,
  resolveAgentBySendNumber,
  PIPELINES,
  PIPELINE_LABELS,
  type Pipeline,
} from "./store.js";

/**
 * Parse an approval button's id ("approve:<phone>" / "reject:<phone>") into a
 * decision, or null if it isn't one of ours. Guards the gate: a malformed or
 * spoofed id must never flip a random number's monitor state, so the phone must
 * be non-empty digits and the prefix must match exactly.
 */
export function parseApprovalId(
  id: string,
): { monitor: "approved" | "rejected"; phone: string } | null {
  const sep = id.indexOf(":");
  if (sep < 0) return null;
  const decision = id.slice(0, sep);
  const phone = id.slice(sep + 1);
  if (!/^\d{6,15}$/.test(phone)) return null; // E.164 digits only, no + / suffix
  if (decision === "approve") return { monitor: "approved", phone };
  if (decision === "reject") return { monitor: "rejected", phone };
  return null;
}

/**
 * Parse `stage <phone> <pipeline>` (the agent moving a lead from WhatsApp), or
 * null if it isn't a stage command → falls through to Q&A. Phone is E.164 digits
 * (same guard as approvals); pipeline must be one of the 8 funnel values, so a
 * typo becomes a plain question rather than a bad write.
 */
export function parseStageCommand(text: string): { phone: string; pipeline: Pipeline } | null {
  const m = text.trim().match(/^stage\s+(\S+)\s+(\S+)$/i);
  if (!m) return null;
  const phone = m[1];
  const pipeline = m[2].toLowerCase();
  if (!/^\d{6,15}$/.test(phone)) return null;
  if (!PIPELINES.includes(pipeline as Pipeline)) return null;
  return { phone, pipeline: pipeline as Pipeline };
}

/**
 * Parse a tapped list-row id ("stage:<phone>:<pipeline>") into phone + pipeline, or
 * null if it isn't one of ours. Trust boundary (same guards as parseApprovalId): a
 * spoofed/malformed id must never write a bad stage, so phone is E.164 digits and
 * pipeline must be one of the 8 funnel values.
 */
export function parseStageSelection(id: string): { phone: string; pipeline: Pipeline } | null {
  const parts = id.split(":");
  if (parts.length !== 3 || parts[0] !== "stage") return null;
  const phone = parts[1];
  const pipeline = parts[2];
  if (!/^\d{6,15}$/.test(phone)) return null;
  if (!PIPELINES.includes(pipeline as Pipeline)) return null;
  return { phone, pipeline: pipeline as Pipeline };
}

/**
 * A tapped stage row arrives as an interactive list_reply whose id we set in
 * askStage. Apply it and return a confirmation DM, or null if the payload isn't one
 * of our stage rows (→ caller falls through). Distinct type from button_reply/text,
 * so approvals, stage taps, and Q&A never collide.
 */
async function handleStageSelection(
  agentId: string,
  msg: {
    type?: string;
    interactive?: { type?: string; list_reply?: { id?: string } };
  },
): Promise<string | null> {
  if (msg?.type !== "interactive" || msg.interactive?.type !== "list_reply") return null;
  const parsed = parseStageSelection(msg.interactive.list_reply?.id ?? "");
  if (!parsed) return null;

  const lead = await findLeadByPhone(agentId, parsed.phone);
  if (!lead) return `No lead on +${parsed.phone}.`;
  await setPipeline(agentId, lead.id, parsed.pipeline);
  return `✓ +${parsed.phone} → ${PIPELINE_LABELS[parsed.pipeline]}`;
}

/**
 * Apply a typed `stage` command, or null if the text isn't one (→ Q&A). Resolves
 * the phone to a lead and moves it, returning the confirmation DM. Uses phone,
 * not name, to avoid the two-Rohans collision.
 */
async function handleStageCommand(agentId: string, text: string): Promise<string | null> {
  const parsed = parseStageCommand(text);
  if (!parsed) return null;

  const lead = await findLeadByPhone(agentId, parsed.phone);
  if (!lead) return `No lead on +${parsed.phone}.`;
  await setPipeline(agentId, lead.id, parsed.pipeline);
  return `✓ +${parsed.phone} → ${PIPELINE_LABELS[parsed.pipeline]}`;
}

/**
 * A tapped approval button arrives as an interactive button_reply whose id we set.
 * Apply the decision and return a confirmation DM, or null if the payload isn't one
 * of our approval buttons (so the caller falls through to Q&A). A button_reply is a
 * distinct message type from typed text, so approvals and Q&A never collide.
 */
async function handleApproval(
  agentId: string,
  msg: {
    type?: string;
    interactive?: { type?: string; button_reply?: { id?: string } };
  },
): Promise<string | null> {
  if (msg?.type !== "interactive" || msg.interactive?.type !== "button_reply") return null;
  const parsed = parseApprovalId(msg.interactive.button_reply?.id ?? "");
  if (!parsed) return null;

  await setMonitor(agentId, parsed.phone, parsed.monitor); // no-op if already decided — idempotent tap.
  return parsed.monitor === "approved"
    ? `Got it — now monitoring +${parsed.phone} as a lead.`
    : `Okay — I'll ignore +${parsed.phone}.`;
}

/**
 * A tapped voice-interview consent button ("voice:start" / "voice:skip"). Returns
 * the bot's reply, or null if it isn't one of ours (→ caller falls through). start
 * flips state to interviewing and sends the intro + first scenario; skip clears the
 * offer. Distinct button ids from approvals/stages, so the three never collide.
 */
async function handleVoiceConsent(
  agentId: string,
  msg: {
    type?: string;
    interactive?: { type?: string; button_reply?: { id?: string } };
  },
): Promise<string | null> {
  if (msg?.type !== "interactive" || msg.interactive?.type !== "button_reply") return null;
  const id = msg.interactive.button_reply?.id ?? "";
  if (id === "voice:start") {
    await setInterviewState(agentId, { phase: "interviewing", step: 0, replies: [] });
    return interviewIntro();
  }
  if (id === "voice:skip") {
    await setInterviewState(agentId, null);
    return 'No problem — say "voice" anytime to teach me your style.';
  }
  return null;
}

/**
 * After an approval tap, offer the voice interview IF: the tap was "approve" (not
 * reject), the agent has no voice card yet, and no interview is already in flight.
 * Sends the consent card and sets state to awaiting_consent. Silent no-op otherwise
 * — a returning agent who already has a card is never re-pestered.
 */
async function maybeOfferVoice(
  agentId: string,
  to: string,
  msg: { interactive?: { type?: string; button_reply?: { id?: string } } },
): Promise<void> {
  const parsed = parseApprovalId(msg.interactive?.button_reply?.id ?? "");
  if (parsed?.monitor !== "approved") return; // only after a Yes, not a No
  const [card, state] = await Promise.all([
    getVoiceCard(agentId),
    getInterviewState(agentId),
  ]);
  if (card.trim() || state) return; // already onboarded or mid-interview → don't offer
  // Send the consent card FIRST, set awaiting_consent state only if it lands. If the
  // send fails and we'd already set state, the agent is stranded: no card to tap, and
  // their later typed "voice" gets swallowed by the consent-answer branch. Order fixes it.
  await askVoiceConsent(to);
  await offerInterview(agentId);
}

/**
 * Is this inbound message a campaign opt-out? A lead who got the marketing blast
 * (sent FROM the company number) replies to that number, so their STOP lands in
 * THIS webhook — as an UNREGISTERED sender. Two forms: (a) a typed STOP-ish keyword,
 * (b) a tap on the template's "Stop promotions" quick-reply button (a button_reply
 * whose title/id says stop). Honouring these is compliance-critical — ignoring
 * opt-outs spikes blocks and drops the WABA quality rating. Exported for the test.
 */
export function isOptOutMessage(msg: {
  type?: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: { type?: string; button_reply?: { id?: string; title?: string } };
}): boolean {
  const looksStop = (s?: string) =>
    !!s && /^\s*(stop|unsubscribe|stop promotions?|opt[\s-]?out)\s*$/i.test(s);
  if (msg?.type === "text") return looksStop(msg.text?.body);
  // Quick-reply on a template button arrives as type "button" (button.text); a
  // free interactive button_reply carries title/id. Cover both shapes.
  if (msg?.type === "button") return looksStop(msg.button?.text);
  if (msg?.type === "interactive" && msg.interactive?.type === "button_reply") {
    return looksStop(msg.interactive.button_reply?.title) || looksStop(msg.interactive.button_reply?.id);
  }
  return false;
}

// Inbound on the COMPANY number (360dialog) is an AGENT texting the bot a
// question — never a lead. 360dialog delivers the Meta message shape, so the
// parser mirrors the old Meta webhook. WHICH agent is resolved from msg.from via
// the registry (resolveAgentBySendNumber); the answer goes back to THAT agent's
// send_number via notifyAgent — never a lead.
// EXCEPTION: a campaign lead's opt-out (STOP) also arrives here as an unregistered
// sender — caught before the agent gate so it's honoured, not dropped.

export const companyRouter = Router();

// GET verify: 360dialog/Meta handshake. Echo hub.challenge when the token matches.
companyRouter.get("/company-webhook", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.DIALOG360_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Handle one agent message end-to-end (opt-out, approval/stage/voice taps, or the
// text branch → interview/voice/stage/Q&A). Runs AFTER the webhook has already
// acked, so a slow LLM call can never delay the 200 (which is what made 360dialog
// retry and DM the same answer 3×). Its own errors are logged, never thrown.
async function handleCompanyMessage(msg: {
  from?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: { type?: string; button_reply?: { id?: string; title?: string }; list_reply?: { id?: string } };
}): Promise<void> {
  // Campaign opt-out FIRST — a lead's STOP arrives from an unregistered number and
  // would otherwise be dropped. Record it; never message the lead back.
  if (msg?.from && isOptOutMessage(msg)) {
    const added = addOptOut(msg.from);
    console.log(`[company] opt-out from ${msg.from}${added ? " (recorded)" : " (already listed)"}`);
    return;
  }

  // Everything else on the company number is an AGENT talking to us. Resolve WHICH
  // agent from msg.from (their send_number); an unregistered sender is dropped.
  const agent = msg?.from ? await resolveAgentBySendNumber(msg.from) : undefined;
  if (!agent) {
    if (msg?.from) console.log(`[company] drop: unregistered sender ${msg.from}`);
    return;
  }
  const to = agent.send_number; // every reply routes back to the asking agent

  // A tapped Yes/No approval button first — distinct type from typed text, so it
  // can't be mistaken for a Q&A question. Falls through to Q&A if not ours.
  const approvalReply = await handleApproval(agent.agent_id, msg);
  const stageSelection =
    approvalReply === null ? await handleStageSelection(agent.agent_id, msg) : null;
  const voiceConsent =
    approvalReply === null && stageSelection === null
      ? await handleVoiceConsent(agent.agent_id, msg)
      : null;
  if (approvalReply !== null) {
    notifyAgent(to, approvalReply).catch((e) => console.error("approval reply failed:", e));
    // Auto-offer the voice interview right after a Yes (open 24h window), only if
    // no card yet and no interview in flight. maybeOfferVoice sets state ONLY on a
    // successful card send, so a failed send can't poison the later `voice` command.
    maybeOfferVoice(agent.agent_id, to, msg).catch((e) =>
      console.error("voice auto-offer failed:", e),
    );
  } else if (stageSelection !== null) {
    notifyAgent(to, stageSelection).catch((e) => console.error("stage selection reply failed:", e));
  } else if (voiceConsent !== null) {
    notifyAgent(to, voiceConsent).catch((e) => console.error("voice consent reply failed:", e));
  } else if (msg.type === "text") {
    const text = msg.text?.body ?? "";
    // Order: 1) an in-progress interview captures the reply (must beat Q&A);
    // 2) a typed "voice" (re)starts the offer; 3) a `stage` command; 4) Q&A.
    let answer = await handleInterviewText(agent.agent_id, text);
    if (answer === null && isVoiceCommand(text)) {
      // offerInterview sets awaiting_consent state; do it only if the card sends,
      // so a failed send doesn't strand the agent in a consent state with no card.
      try {
        await askVoiceConsent(to);
        await offerInterview(agent.agent_id);
      } catch (e) {
        console.error("voice offer failed:", e);
      }
    } else if (answer === null) {
      const stageReply = await handleStageCommand(agent.agent_id, text);
      answer = stageReply ?? (await answerAgentQuestion(agent.agent_id, text));
    }
    if (answer !== null) {
      notifyAgent(to, answer).catch((e) => console.error("qa reply failed:", e));
    }
  }
}

// The typed trigger to (re)start the voice interview. Tolerant of what real
// keyboards send — trim + case-fold + a couple of natural aliases — because an
// exact /^voice$/ match silently fell through to Q&A when the body wasn't bit-exact.
export function isVoiceCommand(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === "voice" || t === "learn my voice" || t === "voice interview";
}

// Recently-processed message ids (dedupe). 360dialog/Meta re-POST the same message
// if an ack is slow OR on their own retry schedule; without this a retry re-runs the
// whole handler and DMs the agent the same answer again. Bounded ring — one agent,
// low volume. ponytail: in-memory set, fine for single process; move to a shared
// store only if this ever runs multi-instance.
const seenMsgIds = new Set<string>();
function alreadyHandled(id: string | undefined): boolean {
  if (!id) return false;
  if (seenMsgIds.has(id)) return true;
  seenMsgIds.add(id);
  if (seenMsgIds.size > 500) seenMsgIds.delete(seenMsgIds.values().next().value!);
  return false;
}

// POST receive: ACK IMMEDIATELY, then process. The LLM classify + store reads used
// to run before the 200, so a slow model let 360dialog retry and the agent got the
// same DM 3×. Now we 200 first and handle async; a message id dedupe absorbs any
// retry the provider fires anyway.
companyRouter.post("/company-webhook", (req: Request, res: Response) => {
  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  const msg = value?.messages?.[0];
  res.sendStatus(200); // ack FIRST — never let downstream work delay this
  // ponytail: diag — remove once voice interview verified live. Records the exact
  // inbound body so a mis-triggered command/tap can be read off, not guessed at.
  console.log(`[company:diag] body=${JSON.stringify(req.body).slice(0, 500)}`);
  if (!msg || alreadyHandled(msg.id)) return;
  handleCompanyMessage(msg).catch((err) => console.error("company message handler error:", err));
});
