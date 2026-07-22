// Minimal agent inbox: fetch threads, render selected thread, send a reply.
let activeId = null;
let lastMsgCount = 0; // messages currently rendered for activeId — detects new inbound without re-fetching on every poll

async function loadThreads() {
  const threads = await fetch("/api/threads").then((r) => r.json());
  const list = document.getElementById("list");
  list.querySelectorAll(".thread").forEach((el) => el.remove());
  for (const t of threads) {
    const el = document.createElement("div");
    el.className = "thread" + (t.id === activeId ? " active" : "");
    el.innerHTML = `
      <div class="name">${escapeHtml(t.name || "Unknown")}</div>
      <div class="phone">${escapeHtml(t.phone)}</div>
      <div class="stage">${t.stage.replace("_", " ")}</div>
      ${responsivenessBadge(t)}`;
    el.onclick = () => openThread(t.id);
    list.appendChild(el);
  }
}

// Poll the open thread; only re-render when the message count changed so we
// don't blow away the draft text box or scroll position on every tick.
async function pollActiveThread() {
  if (activeId == null) return;
  const t = await fetch(`/api/threads/${activeId}`).then((r) => r.json());
  if (t.messages.length !== lastMsgCount) {
    const draft = document.querySelector("#custom input")?.value ?? "";
    await openThread(activeId, t);
    const input = document.querySelector("#custom input");
    if (input && draft) input.value = draft;
  }
}

async function openThread(id, preloaded) {
  activeId = id;
  const t = preloaded ?? (await fetch(`/api/threads/${id}`).then((r) => r.json()));
  lastMsgCount = t.messages.length;
  const field = (k, v) =>
    `<div class="field"><div class="k">${k}</div><div class="v ${
      v ? "" : "missing"
    }">${v ? escapeHtml(v) : "missing"}</div></div>`;
  const msgs = t.messages
    .map(
      (m) =>
        `<div class="msg ${m.direction}">${escapeHtml(m.body)}</div>`,
    )
    .join("");
  const replies = t.replies
    .filter((r) => r.trim())
    .map(
      (r) => `<button class="reply">${escapeHtml(r)}</button>`,
    )
    .join("");

  const factList = (t.facts || [])
    .map((f) => `<li>${escapeHtml(f)}</li>`)
    .join("");
  const memory =
    t.summary || factList
      ? `<div id="memory">
           <h3>Memory</h3>
           ${t.summary ? `<p class="summary">${escapeHtml(t.summary)}</p>` : ""}
           ${factList ? `<ul class="facts">${factList}</ul>` : ""}
         </div>`
      : "";

  document.getElementById("detail").innerHTML = `
    <div id="fields">
      ${field("Budget", t.budget)}
      ${field("Area", t.area)}
      ${field("Requirement", t.requirement)}
      ${t.next_question ? `<div id="next-q">Next: ${escapeHtml(t.next_question)}</div>` : ""}
    </div>
    ${memory}
    <div id="messages">${msgs}</div>
    <div id="replies">
      <h3>Suggested replies</h3>
      ${replies}
      <div id="custom">
        <input placeholder="Write your own…" />
        <button>Send</button>
      </div>
    </div>`;

  document.querySelectorAll(".reply").forEach((b) => {
    b.onclick = () => send(b.textContent);
  });
  const input = document.querySelector("#custom input");
  const btn = document.querySelector("#custom button");
  btn.onclick = () => input.value.trim() && send(input.value.trim());
  input.onkeydown = (e) => {
    if (e.key === "Enter" && input.value.trim()) send(input.value.trim());
  };

  if (!preloaded) loadThreads(); // refresh active highlight (skip on poll-driven re-render, already fresh)
  const msgsEl = document.getElementById("messages");
  if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
}

async function send(body) {
  try {
    const res = await fetch("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lead_id: activeId, body }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      alert(`Message NOT sent (${res.status}). ${detail.error || "See server log."}`);
      return; // don't re-render as if it worked
    }
  } catch (e) {
    alert(`Message NOT sent — network error: ${e.message}`);
    return;
  }
  await openThread(activeId); // reload thread so the sent message shows
  // Keep the view at the latest message instead of jumping to the top.
  const msgs = document.getElementById("messages");
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
}

// "Went quiet" / "awaiting" badge from the derived responsiveness state.
function responsivenessBadge(t) {
  if (t.state === "no_reply") {
    return `<div class="badge no-reply">⚠ no reply · ${humanAge(t.silent_ms)}</div>`;
  }
  if (t.state === "awaiting_reply") {
    return `<div class="badge awaiting">⏳ awaiting · ${humanAge(t.silent_ms)}</div>`;
  }
  return `<div class="badge active">message sent</div>`; // active — ball's in the agent's court
}

function humanAge(ms) {
  if (ms == null) return "";
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return "<1h";
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

loadThreads();
setInterval(() => {
  loadThreads();
  pollActiveThread();
}, 3000); // pick up new inbound messages without a manual refresh
