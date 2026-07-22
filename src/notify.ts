/**
 * The single outbound seam: every agent-facing feature (suggestions, summaries,
 * reminders, Q&A answers) sends through here to the agent on the company number.
 * The bot NEVER messages a lead — this only ever targets AGENT_COMPANY_NUMBER.
 *
 * Transport is 360dialog (the only sender — the BSP selector is collapsed away,
 * since the lead side is read-only and never sends). Same Meta Graph message
 * schema, but the API key alone identifies the channel (no phone-number-id in the
 * path) and auth is a raw D360-API-KEY header.
 */

/** Send a WhatsApp text to `to` (E.164, no +) via 360dialog. Resolves when accepted. */
async function companySend(to: string, body: string): Promise<void> {
  const apiKey = process.env.DIALOG360_API_KEY;
  const baseUrl = process.env.DIALOG360_API_URL;
  if (!apiKey || !baseUrl) {
    throw new Error("DIALOG360_API_KEY and DIALOG360_API_URL must be set");
  }
  const res = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "D360-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`360dialog send failed (${res.status}): ${detail}`);
  }
}

export async function notifyAgent(body: string): Promise<void> {
  const to = process.env.AGENT_COMPANY_NUMBER;
  if (!to) throw new Error("AGENT_COMPANY_NUMBER must be set");
  await companySend(to, body);
}

/**
 * Ask the agent (on the company number) to approve/reject monitoring a new number,
 * as two tappable WhatsApp reply buttons. Each button's id carries the contact's
 * phone, so a tap is unambiguous even with several pending — and a button_reply is
 * a distinct message type from typed Q&A text, so the two never collide. See the
 * WhatsApp interactive-message shape (360dialog mirrors Meta's Cloud API).
 */
export async function askApproval(phone: string, name?: string): Promise<void> {
  const apiKey = process.env.DIALOG360_API_KEY;
  const baseUrl = process.env.DIALOG360_API_URL;
  const to = process.env.AGENT_COMPANY_NUMBER;
  if (!apiKey || !baseUrl) throw new Error("DIALOG360_API_KEY and DIALOG360_API_URL must be set");
  if (!to) throw new Error("AGENT_COMPANY_NUMBER must be set");

  const who = name ? `${name} (+${phone})` : `+${phone}`;
  const res = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: { "D360-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: `New contact: ${who}. Monitor them as a lead?` },
        action: {
          buttons: [
            // id (not title) is what comes back on tap — encode the decision + phone.
            { type: "reply", reply: { id: `approve:${phone}`, title: "Yes" } },
            { type: "reply", reply: { id: `reject:${phone}`, title: "No" } },
          ],
        },
      },
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`360dialog approval prompt failed (${res.status}): ${detail}`);
  }
}
