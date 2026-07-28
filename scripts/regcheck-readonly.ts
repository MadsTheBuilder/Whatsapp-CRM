import "dotenv/config";
import { listAllAgents, resolveAgentByReadNumber } from "../src/store.js";

// Read-only registry check — no mutation. Prove Mitko's row resolves before
// flipping the pipe to dialog360.
(async () => {
  const all = await listAllAgents();
  console.log("registry rows:", JSON.stringify(all, null, 2));
  for (const a of all) {
    const r = await resolveAgentByReadNumber(a.read_number);
    console.log(
      `resolve ${a.read_number} =>`,
      r ? `${r.agent_id} send=${r.send_number} ✅` : "NULL (would drop!)",
    );
  }
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
