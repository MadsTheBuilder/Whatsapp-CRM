import "dotenv/config";
import express, { type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { webhookRouter } from "./webhook.js";
import {
  listLeads,
  getLead,
  getMessages,
  getFacts,
  responsiveness,
  saveMessage,
  type Lead,
} from "./store.js";
import { makeBSP } from "./bsp/index.js";

const AGENT_ID = process.env.AGENT_ID ?? "agent_demo";
const PORT = Number(process.env.PORT ?? 3000);
const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// Meta Cloud API webhook (GET verify + POST receive)
app.use(webhookRouter);

// Serve the minimal inbox UI
app.use(express.static(join(__dirname, "web")));

// PropertyFinder listings snapshot (pulled via MCP, refreshed manually).
type Listing = {
  category: string;
  price: number;
  bedrooms: number;
  area: string;
  furnished: string;
};
const listingsFile = join(__dirname, "web", "listings.json");

// Filtered search over the snapshot. Query: category, area, min_beds, min_price, max_price, furnished.
app.get("/api/properties", (req: Request, res: Response) => {
  const snap = JSON.parse(readFileSync(listingsFile, "utf8")) as {
    pulled_at: string;
    listings: Listing[];
  };
  const { category, area, min_beds, min_price, max_price, furnished } = req.query;
  const out = snap.listings.filter((l) => {
    if (category && l.category !== category) return false;
    if (area && l.area !== area) return false;
    if (min_beds && l.bedrooms < Number(min_beds)) return false;
    if (min_price && l.price < Number(min_price)) return false;
    if (max_price && l.price > Number(max_price)) return false;
    if (furnished && l.furnished !== furnished) return false;
    return true;
  });
  res.json({ pulled_at: snap.pulled_at, count: out.length, listings: out });
});

/** Shape a lead row for the inbox: fields, missing list, cached replies. */
function threadView(lead: Lead) {
  const missing: string[] = [];
  if (!lead.budget) missing.push("budget");
  if (!lead.area) missing.push("area");
  if (!lead.requirement) missing.push("requirement");
  return {
    id: lead.id,
    phone: lead.phone,
    name: lead.name,
    stage: lead.stage,
    budget: lead.budget,
    area: lead.area,
    requirement: lead.requirement,
    missing,
    next_question: lead.next_question,
    replies: lead.replies_json ? (JSON.parse(lead.replies_json) as string[]) : [],
    summary: lead.summary,
    facts: getFacts(AGENT_ID, lead.id),
    ...responsiveness(AGENT_ID, lead.id),
  };
}

// List conversations for the inbox left pane.
app.get("/api/threads", (_req: Request, res: Response) => {
  res.json(listLeads(AGENT_ID).map(threadView));
});

// Full thread: lead fields + message history.
app.get("/api/threads/:id", (req: Request, res: Response) => {
  const lead = getLead(AGENT_ID, Number(req.params.id));
  if (!lead) {
    res.sendStatus(404);
    return;
  }
  res.json({
    ...threadView(lead),
    messages: getMessages(AGENT_ID, lead.id),
  });
});

// Agent picks a reply (or types custom) → send through the BSP adapter.
const bsp = makeBSP();
app.post("/api/send", async (req: Request, res: Response) => {
  const { lead_id, body } = req.body ?? {};
  if (typeof lead_id !== "number" || typeof body !== "string" || !body.trim()) {
    res.status(400).json({ error: "lead_id (number) and body (string) required" });
    return;
  }
  const lead = getLead(AGENT_ID, lead_id);
  if (!lead) {
    res.sendStatus(404);
    return;
  }
  try {
    await bsp.send(lead.phone, body);
    saveMessage(AGENT_ID, lead.id, "out", body);
    res.json({ ok: true });
  } catch (err) {
    console.error("send error:", err);
    res.status(502).json({ error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`FourthspaceOS MVP on http://localhost:${PORT}/inbox.html`);
  console.log(`BSP=${process.env.BSP ?? "mock"}  MODEL=${process.env.MODEL ?? "claude-sonnet-5"}`);
});
