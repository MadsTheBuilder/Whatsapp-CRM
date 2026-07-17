import OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";

// Routed through OpenRouter (OpenAI-compatible) for free-model testing.
// The Anthropic SDK is unused at runtime now — we keep its InputSchema *type*
// only so qualify.ts / replies.ts don't have to change.
// ponytail: single provider client here — swap baseURL back to Anthropic and
// use one MODEL when a real key is available.
export const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
  baseURL: "https://openrouter.ai/api/v1",
  timeout: 30000,
  maxRetries: 0,
});

// MODEL is tried first; the rest are fallbacks for when a free model is
// rate-limited (free OpenRouter models 429/402 constantly). First that answers
// wins. Add your own OpenRouter credits to make any single model reliable.
const PRIMARY = process.env.MODEL ?? "google/gemma-4-31b-it:free";
const FALLBACKS = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
];
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

function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
