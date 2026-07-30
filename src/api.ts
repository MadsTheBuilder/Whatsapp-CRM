import { Router, type Request, type Response } from "express";
import {
  listAgents,
  listAllAgents,
  registerAgent,
  leadsForBoard,
  getLead,
  getMessages,
  setPipeline,
  PIPELINES,
  type Pipeline,
} from "./store.js";

// Read/write API for the Control Center dashboard. Every handler goes through
// the service-role store — Supabase is NEVER exposed to the browser, so the
// existing security model holds. Routes read the whole store server-side and
// hand plain JSON out.
// ponytail: the board read routes below still take AGENT_ID from env — the
// dashboard picking WHICH agent to view is a separate change (out of scope for
// the identity fix, which is inbound/outbound routing).
const AGENT_ID = process.env.AGENT_ID ?? "agent_demo";

export const apiRouter = Router();

// Agent registry admin. The receiving number selects the lane, so every agent
// must have a row: read_number (what the bot reads inbound on) → agent_id +
// send_number (where the bot sends help). Numbers are normalized to bare digits
// in the store. GET lists them; POST registers one.
apiRouter.get("/api/agents/registry", async (_req: Request, res: Response) => {
  try {
    res.json(await listAllAgents());
  } catch (err) {
    console.error("GET /api/agents/registry:", err);
    res.sendStatus(500);
  }
});

apiRouter.post("/api/agents", async (req: Request, res: Response) => {
  try {
    const { agent_id, read_number, send_number, name, goyzer_number } = req.body ?? {};
    const isDigits = (v: unknown) => typeof v === "string" && /\d{6,15}/.test(v.replace(/\D/g, ""));
    if (typeof agent_id !== "string" || !agent_id.trim()) {
      return res.status(400).json({ error: "agent_id required" });
    }
    if (!isDigits(read_number) || !isDigits(send_number)) {
      return res.status(400).json({ error: "read_number and send_number must be phone numbers" });
    }
    if (goyzer_number !== undefined && goyzer_number !== null && !isDigits(goyzer_number)) {
      return res.status(400).json({ error: "goyzer_number must be a phone number" });
    }
    const agent = await registerAgent({
      agent_id: agent_id.trim(),
      read_number,
      send_number,
      name: typeof name === "string" ? name : undefined,
      goyzer_number: isDigits(goyzer_number) ? goyzer_number : undefined,
    });
    res.status(201).json(agent);
  } catch (err) {
    // Unique-constraint clash (duplicate agent_id or read_number) → 409, not 500.
    if ((err as { code?: string })?.code === "23505") {
      return res.status(409).json({ error: "agent_id or read_number already registered" });
    }
    console.error("POST /api/agents:", err);
    res.sendStatus(500);
  }
});

// Dashboard cards: one row per connected agent + aggregate counts.
apiRouter.get("/api/agents", async (_req: Request, res: Response) => {
  try {
    res.json(await listAgents());
  } catch (err) {
    console.error("GET /api/agents:", err);
    res.sendStatus(500);
  }
});

// Kanban: approved leads for an agent, each with a live responsiveness badge.
// The client groups by the stored `pipeline` column into the 8 columns.
apiRouter.get("/api/agents/:agentId/board", async (req: Request, res: Response) => {
  try {
    res.json(await leadsForBoard(req.params.agentId));
  } catch (err) {
    console.error("GET board:", err);
    res.sendStatus(500);
  }
});

// Lead detail: name, phone, budget, requirement, summary, pipeline.
apiRouter.get("/api/leads/:id", async (req: Request, res: Response) => {
  try {
    const lead = await getLead(AGENT_ID, Number(req.params.id));
    if (!lead) return res.sendStatus(404);
    res.json(lead);
  } catch (err) {
    console.error("GET lead:", err);
    res.sendStatus(500);
  }
});

// Chat transcript for the read-only WhatsApp panel.
apiRouter.get("/api/leads/:id/messages", async (req: Request, res: Response) => {
  try {
    res.json(await getMessages(AGENT_ID, Number(req.params.id)));
  } catch (err) {
    console.error("GET messages:", err);
    res.sendStatus(500);
  }
});

// Move a lead to a funnel stage (dashboard dropdown/drag). Validate against the
// 8 allowed values before writing — defense in depth alongside the DB CHECK.
apiRouter.post("/api/leads/:id/pipeline", async (req: Request, res: Response) => {
  try {
    const pipeline = req.body?.pipeline as Pipeline;
    if (!PIPELINES.includes(pipeline)) return res.status(400).json({ error: "invalid pipeline" });
    const moved = await setPipeline(AGENT_ID, Number(req.params.id), pipeline);
    if (!moved) return res.sendStatus(404);
    res.json({ ok: true, pipeline });
  } catch (err) {
    console.error("POST pipeline:", err);
    res.sendStatus(500);
  }
});
