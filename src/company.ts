import { Router, type Request, type Response } from "express";
import { answerAgentQuestion } from "./qa.js";
import { notifyAgent } from "./notify.js";
import {
  setMonitor,
  setPipeline,
  findLeadByPhone,
  PIPELINES,
  PIPELINE_LABELS,
  type Pipeline,
} from "./store.js";

const AGENT_ID = process.env.AGENT_ID ?? "agent_demo";

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
async function handleStageSelection(msg: {
  type?: string;
  interactive?: { type?: string; list_reply?: { id?: string } };
}): Promise<string | null> {
  if (msg?.type !== "interactive" || msg.interactive?.type !== "list_reply") return null;
  const parsed = parseStageSelection(msg.interactive.list_reply?.id ?? "");
  if (!parsed) return null;

  const lead = await findLeadByPhone(AGENT_ID, parsed.phone);
  if (!lead) return `No lead on +${parsed.phone}.`;
  await setPipeline(AGENT_ID, lead.id, parsed.pipeline);
  return `✓ +${parsed.phone} → ${PIPELINE_LABELS[parsed.pipeline]}`;
}

/**
 * Apply a typed `stage` command, or null if the text isn't one (→ Q&A). Resolves
 * the phone to a lead and moves it, returning the confirmation DM. Uses phone,
 * not name, to avoid the two-Rohans collision.
 */
async function handleStageCommand(text: string): Promise<string | null> {
  const parsed = parseStageCommand(text);
  if (!parsed) return null;

  const lead = await findLeadByPhone(AGENT_ID, parsed.phone);
  if (!lead) return `No lead on +${parsed.phone}.`;
  await setPipeline(AGENT_ID, lead.id, parsed.pipeline);
  return `✓ +${parsed.phone} → ${PIPELINE_LABELS[parsed.pipeline]}`;
}

/**
 * A tapped approval button arrives as an interactive button_reply whose id we set.
 * Apply the decision and return a confirmation DM, or null if the payload isn't one
 * of our approval buttons (so the caller falls through to Q&A). A button_reply is a
 * distinct message type from typed text, so approvals and Q&A never collide.
 */
async function handleApproval(msg: {
  type?: string;
  interactive?: { type?: string; button_reply?: { id?: string } };
}): Promise<string | null> {
  if (msg?.type !== "interactive" || msg.interactive?.type !== "button_reply") return null;
  const parsed = parseApprovalId(msg.interactive.button_reply?.id ?? "");
  if (!parsed) return null;

  await setMonitor(AGENT_ID, parsed.phone, parsed.monitor); // no-op if already decided — idempotent tap.
  return parsed.monitor === "approved"
    ? `Got it — now monitoring +${parsed.phone} as a lead.`
    : `Okay — I'll ignore +${parsed.phone}.`;
}

// Inbound on the COMPANY number (360dialog) is the AGENT texting the bot a
// question — never a lead. 360dialog delivers the Meta message shape, so the
// parser mirrors the old Meta webhook. The answer goes back to the agent via
// notifyAgent (which always targets AGENT_COMPANY_NUMBER — never a lead).

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

// POST receive: parse the agent's question, answer from the store, DM the answer.
// Ack fast; the LLM classify + store read run inline (low volume — one agent).
companyRouter.post("/company-webhook", async (req: Request, res: Response) => {
  try {
    // ponytail: diag — remove once approval tap delivery confirmed. Proves whether
    // 360dialog is POSTing the tap to us at all (needs a public tunnel to reach localhost).
    console.log(`[company:diag] POST hit; body=${JSON.stringify(req.body).slice(0, 500)}`);
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];

    // Everything on the company number is the AGENT talking to us. Ignore status
    // callbacks (delivery/read receipts arrive as value.statuses, no messages[])
    // and, if AGENT_COMPANY_NUMBER is set, anything not from that number.
    const agentNumber = process.env.AGENT_COMPANY_NUMBER;
    if (msg && (!agentNumber || msg.from === agentNumber)) {
      // A tapped Yes/No approval button first — distinct type from typed text, so
      // it can't be mistaken for a Q&A question. Falls through to Q&A if not ours.
      const approvalReply = await handleApproval(msg);
      const stageSelection = approvalReply === null ? await handleStageSelection(msg) : null;
      if (approvalReply !== null) {
        notifyAgent(approvalReply).catch((e) => console.error("approval reply failed:", e));
      } else if (stageSelection !== null) {
        notifyAgent(stageSelection).catch((e) => console.error("stage selection reply failed:", e));
      } else if (msg.type === "text") {
        // Try a `stage` command first; if it's not one, fall through to Q&A.
        const text = msg.text.body as string;
        const stageReply = await handleStageCommand(text);
        const answer = stageReply ?? (await answerAgentQuestion(text));
        // fire-and-forget: a failed reply DM must not turn into a 500 that makes
        // 360dialog retry the same question.
        notifyAgent(answer).catch((e) => console.error("qa reply failed:", e));
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("company-webhook error:", err);
    res.sendStatus(200); // ack and log — a non-2xx just triggers provider retries.
  }
});
