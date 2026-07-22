import "dotenv/config"; // MUST be first — store.ts throws at import if SUPABASE_* unset.
import express from "express";
import { companyRouter } from "./company.js";
import { startBaileys } from "./pipe/baileys.js";
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

// Read-pipe: connect to the agent's WhatsApp. A boot failure here is fatal —
// without it the brain never sees a message, so let it crash rather than run blind.
startBaileys().catch((e) => {
  console.error("[server] baileys failed to start:", e);
  process.exit(1);
});

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
