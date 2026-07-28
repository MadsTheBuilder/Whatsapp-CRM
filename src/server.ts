import "dotenv/config"; // MUST be first — store.ts throws at import if SUPABASE_* unset.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { companyRouter } from "./company.js";
import { apiRouter } from "./api.js";
import { startBaileys } from "./pipe/baileys.js";
import { agentRouter } from "./pipe/dialog360.js";
import { runDailyReminders, REMINDER_INTERVAL_MS } from "./reminders.js";

// Thin bootstrap. It wires the three live pieces together and does nothing else:
//   - Baileys read-pipe on the AGENT's number  (reads lead chats → brain)
//   - /company-webhook on the COMPANY number    (agent's Q&A → answer → DM)
//   - a daily reminder tick                      (3-day-silent leads → digest DM)
// No /api/send, /api/threads, /api/properties or web UI — the bot never sends to
// a lead, so there is nothing for a lead-facing route or inbox to do here.

const PORT = Number(process.env.PORT ?? 3000);

const app = express();
app.use(express.json()); // 360dialog posts JSON; companyRouter reads req.body
app.use(companyRouter);
app.use(apiRouter); // Control Center read/write API (dashboard) — service-role store only.

// Agent read-pipe selector. The company number is always 360dialog (sends only);
// the AGENT number's read-pipe is swappable — Baileys (dev, unofficial) or a second
// 360dialog channel (real agent). Both feed the brain the same event shape.
//   baileys  — long-lived Baileys socket (default; keeps the dev path).
//   dialog360 — a webhook on this same app (/agent-webhook), coexistence-mirrored.
const AGENT_PIPE = process.env.AGENT_PIPE ?? "baileys";
if (AGENT_PIPE === "dialog360") {
  app.use(agentRouter); // /agent-webhook — mounted only in this mode
  console.log("[server] agent pipe: dialog360 (/agent-webhook)");
}

// Serve the single-file dashboard. It fetch()es the /api routes above. Run via
// tsx (no build step), so this file lives at src/server.ts — the mockup is one
// level up in mockups/. One static html file, no frontend build.
const dir = path.dirname(fileURLToPath(import.meta.url));
app.get("/", (_req, res) =>
  res.sendFile(path.resolve(dir, "..", "mockups", "control-center.html")),
);

// Read-pipe: connect to the agent's WhatsApp via Baileys. A boot failure here is
// fatal — without it the brain never sees a message, so let it crash rather than
// run blind. Skipped in dialog360 mode (that pipe is a webhook, mounted above).
if (AGENT_PIPE !== "dialog360") {
  console.log("[server] agent pipe: baileys");
  startBaileys().catch((e) => {
    console.error("[server] baileys failed to start:", e);
    process.exit(1);
  });
}

// Daily follow-up digest: once on boot, then every 24h. A failed run must not kill
// the process (a transient store/360dialog error shouldn't take the server down) —
// runDailyReminders doesn't swallow its own errors, so catch here.
const reminderTick = () =>
  runDailyReminders().catch((e) => console.error("[server] reminder run failed:", e));
reminderTick();
// ponytail: in-process setInterval, fine for one agent. Move to a real scheduler
// (cron/pg_cron) if this ever needs to survive restarts or run multi-agent.
setInterval(reminderTick, REMINDER_INTERVAL_MS);

app.listen(PORT, () => console.log(`[server] company-webhook listening on :${PORT}`));
