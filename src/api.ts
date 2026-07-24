import { Router, type Request, type Response } from "express";
import {
  listAgents,
  leadsForBoard,
  getLead,
  getMessages,
  setPipeline,
  PIPELINES,
  type Pipeline,
} from "./store.js";

// Read/write API for the Control Center dashboard. Every handler goes through
// the service-role store — Supabase is NEVER exposed to the browser, so the
// existing security model holds. One agent for now; AGENT_ID from env, exactly
// as company.ts. Routes read the whole store server-side and hand plain JSON out.
const AGENT_ID = process.env.AGENT_ID ?? "agent_demo";

export const apiRouter = Router();

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
