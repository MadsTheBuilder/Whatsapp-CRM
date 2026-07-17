import Anthropic from "@anthropic-ai/sdk";

export const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

export const MODEL = process.env.MODEL ?? "claude-sonnet-5";

/**
 * One structured call: force a tool with `schema` as its input, return the
 * validated input object. Forced tool_choice is the reliable extraction path
 * on this SDK version — Claude must call the tool, so we always get JSON back.
 */
export async function structured<T>(
  system: string,
  user: string,
  schema: Anthropic.Tool.InputSchema,
): Promise<T> {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: user }],
    tools: [
      {
        name: "record",
        description: "Record the structured result.",
        input_schema: schema,
      },
    ],
    tool_choice: { type: "tool", name: "record" },
  });
  const toolUse = res.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Claude did not return the expected tool call");
  }
  return toolUse.input as T;
}
