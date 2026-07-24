import "dotenv/config";
const t0 = Date.now();
const res = await fetch("http://localhost:11434/api/chat", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: process.env.MODEL ?? "gemma4:12b",
    stream: false,
    messages: [{ role: "user", content: "Reply with exactly the word: pong" }],
  }),
});
const data = await res.json();
console.log(`status=${res.status} elapsed=${Date.now()-t0}ms`);
console.log("content:", data?.message?.content ?? JSON.stringify(data).slice(0,200));
