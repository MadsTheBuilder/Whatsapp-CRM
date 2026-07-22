import OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";

// OpenAI-compatible client. Two supported backends, selected by LLM_BASE_URL:
//   - Ollama (local, default):  http://localhost:11434/v1  — no rate limits.
//   - OpenRouter (cloud):       https://openrouter.ai/api/v1 — free models flaky.
// Swap by setting LLM_BASE_URL + MODEL in .env; no code change.
// The Anthropic SDK is unused at runtime — we keep its InputSchema *type* only
// so qualify.ts / replies.ts don't have to change.
const BASE_URL = process.env.LLM_BASE_URL ?? "http://localhost:11434/v1";
// Ollama's OpenAI-compat layer ignores forced tool_choice (returns prose), but
// its native /api/chat honors `format: <schema>` for reliable structured JSON.
// So on Ollama we bypass the OpenAI SDK and hit /api/chat directly.
const IS_OLLAMA = /localhost:11434|127\.0\.0\.1:11434/.test(BASE_URL);
const OLLAMA_CHAT = BASE_URL.replace(/\/v1\/?$/, "") + "/api/chat";

export const client = new OpenAI({
  apiKey:
    process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? "ollama",
  baseURL: BASE_URL,
  timeout: 60000, // local models are slower to first token than a hosted API
  maxRetries: 0,
});

// MODEL is tried first; FALLBACKS only matter for the flaky cloud free tier.
// With local Ollama there's one model and no rate limits, so the chain is just
// [MODEL]. Keep OpenRouter fallbacks here for when LLM_BASE_URL points at it.
const PRIMARY = process.env.MODEL ?? "llama3.1:8b";
const FALLBACKS = (process.env.MODEL_FALLBACKS ?? "")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
export const MODEL = PRIMARY;
const MODEL_CHAIN = [PRIMARY, ...FALLBACKS.filter((m) => m !== PRIMARY)];

/**
 * One structured call: force a tool with `schema` as its arguments, return the
 * parsed arguments. Tries each model in MODEL_CHAIN until one answers — free
 * models rate-limit unpredictably, so we fall through on 402/429/5xx.
 */
export async function structured<T>(
  system: string,
  user: string,
  schema: Anthropic.Tool.InputSchema,
): Promise<T> {
  if (IS_OLLAMA) return ollamaStructured<T>(system, user, schema);

  let lastErr: unknown;
  for (const model of MODEL_CHAIN) {
    try {
      const res = (await client.chat.completions.create({
        model,
        max_tokens: 1024,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "record",
              description: "Record the structured result.",
              parameters: schema as Record<string, unknown>,
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "record" } },
      })) as OpenAI.Chat.Completions.ChatCompletion & { error?: unknown };

      // Free models sometimes return an error body with a 200 status.
      if (res.error) throw new Error(`provider error: ${JSON.stringify(res.error)}`);

      const call = res.choices?.[0]?.message?.tool_calls?.[0];
      if (!call || call.type !== "function") {
        throw new Error("no tool call in response");
      }
      return JSON.parse(call.function.arguments) as T;
    } catch (err) {
      lastErr = err;
      console.warn(`[claude] ${model} failed, trying next: ${errMsg(err)}`);
    }
  }
  throw new Error(`all models failed. last: ${errMsg(lastErr)}`);
}

/**
 * Ollama path: use native /api/chat with `format: <json schema>`, which
 * constrains generation to schema-valid JSON (tool_choice is unreliable here).
 * The model's message.content IS the JSON object.
 */
async function ollamaStructured<T>(
  system: string,
  user: string,
  schema: Anthropic.Tool.InputSchema,
): Promise<T> {
  const res = await fetch(OLLAMA_CHAT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: PRIMARY,
      stream: false,
      format: schema,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { message?: { content?: string } };
  const content = data.message?.content;
  if (!content) throw new Error("ollama: empty response");
  return JSON.parse(content) as T; // format:schema guarantees valid JSON
}

function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
