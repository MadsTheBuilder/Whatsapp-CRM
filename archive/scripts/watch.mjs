// Poll the live inbox; emit a line whenever a thread changes (new msg, state flip,
// new summary/facts). This surfaces real inbound WhatsApp traffic + the system's
// reaction, since a successful webhook is otherwise silent in server.log.
const URL = "http://localhost:3000/api/threads";
const seen = new Map(); // id -> fingerprint

const fp = (t) =>
  [t.state, t.replies?.length, t.summary ? 1 : 0, t.facts?.length, t.budget, t.area, t.requirement].join("|");

async function tick() {
  let threads;
  try {
    const r = await fetch(URL);
    threads = await r.json();
  } catch (e) {
    return; // server restarting (tsx reload) — skip this tick
  }
  for (const t of threads) {
    const now = fp(t);
    const prev = seen.get(t.id);
    if (prev === undefined) { seen.set(t.id, now); continue; } // baseline, no spam on boot
    if (prev !== now) {
      seen.set(t.id, now);
      const badge = t.state === "no_reply" ? "🔴 NO REPLY"
        : t.state === "awaiting_reply" ? "🟠 awaiting"
        : "🟢 active";
      console.log(`[${t.name || t.phone}] ${badge} | budget=${t.budget ?? "-"} area=${t.area ?? "-"} req=${t.requirement ?? "-"} | replies=${t.replies?.length ?? 0} summary=${t.summary ? "yes" : "no"} facts=${t.facts?.length ?? 0}`);
    }
  }
}

console.log("watch armed");
setInterval(tick, 3000);
