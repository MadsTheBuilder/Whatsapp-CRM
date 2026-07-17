// Minimal agent inbox: fetch threads, render selected thread, send a reply.
let activeId = null;

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
      <div class="stage">${t.stage.replace("_", " ")}</div>`;
    el.onclick = () => openThread(t.id);
    list.appendChild(el);
  }
}

async function openThread(id) {
  activeId = id;
  const t = await fetch(`/api/threads/${id}`).then((r) => r.json());
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

  document.getElementById("detail").innerHTML = `
    <div id="fields">
      ${field("Budget", t.budget)}
      ${field("Area", t.area)}
      ${field("Requirement", t.requirement)}
      ${t.next_question ? `<div id="next-q">Next: ${escapeHtml(t.next_question)}</div>` : ""}
    </div>
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

  loadThreads(); // refresh active highlight
}

async function send(body) {
  await fetch("/api/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lead_id: activeId, body }),
  });
  openThread(activeId);
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

loadThreads();
setInterval(loadThreads, 5000); // pick up new inbound messages
