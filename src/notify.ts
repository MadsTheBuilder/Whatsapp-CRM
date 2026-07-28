/**
 * The single outbound seam: every agent-facing feature (suggestions, summaries,
 * reminders, Q&A answers) sends through here to ONE agent on the company number.
 * The destination `to` is the originating agent's send_number, resolved at the
 * door (dialog360/baileys) or the company webhook — never a global env value, so
 * each agent only ever hears about their own leads. The bot NEVER messages a lead.
 *
 * Transport is 360dialog (the only sender — the BSP selector is collapsed away,
 * since the lead side is read-only and never sends). Same Meta Graph message
 * schema, but the API key alone identifies the channel (no phone-number-id in the
 * path) and auth is a raw D360-API-KEY header.
 */

import { PIPELINES, PIPELINE_LABELS } from "./store.js";

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

export async function notifyAgent(to: string, body: string): Promise<void> {
  if (!to) throw new Error("notifyAgent: destination (agent send_number) required");
  await companySend(to, body);
}

/**
 * Send an approved WhatsApp template to `to` (E.164, no +) via 360dialog. `params`
 * fill the body's {{1}}, {{2}}, … in order (empty → a no-variable template). This
 * is the ONLY sanctioned path that messages a NON-agent number — the opt-out-aware,
 * paced campaign blast (scripts/blast.ts) uses it to re-open old funnel leads. A
 * template is the only legal way to message outside the 24h window; free-form text
 * to a cold contact would be rejected. Same channel/auth as companySend — so the
 * same function serves any future 360dialog number, just a different API key.
 */
export async function sendTemplate(
  to: string,
  templateName: string,
  languageCode: string,
  params: string[],
): Promise<void> {
  const apiKey = process.env.DIALOG360_API_KEY;
  const baseUrl = process.env.DIALOG360_API_URL;
  if (!apiKey || !baseUrl) throw new Error("DIALOG360_API_KEY and DIALOG360_API_URL must be set");
  if (!to) throw new Error("sendTemplate: destination required");

  const components = params.length
    ? [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }]
    : [];
  const res = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: { "D360-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: { name: templateName, language: { code: languageCode }, components },
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`360dialog template send failed (${res.status}): ${detail}`);
  }
}

/**
 * Ask the agent (on the company number) to approve/reject monitoring a new number,
 * as two tappable WhatsApp reply buttons. Each button's id carries the contact's
 * phone, so a tap is unambiguous even with several pending — and a button_reply is
 * a distinct message type from typed Q&A text, so the two never collide. See the
 * WhatsApp interactive-message shape (360dialog mirrors Meta's Cloud API).
 */
export async function askApproval(to: string, phone: string, name?: string): Promise<void> {
  const apiKey = process.env.DIALOG360_API_KEY;
  const baseUrl = process.env.DIALOG360_API_URL;
  if (!apiKey || !baseUrl) throw new Error("DIALOG360_API_KEY and DIALOG360_API_URL must be set");
  if (!to) throw new Error("askApproval: destination (agent send_number) required");

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

/**
 * Offer the agent the in-WhatsApp voice interview, as two tappable buttons. A tap
 * comes back as a button_reply with id voice:start / voice:skip (handled in
 * company.ts). Same interactive shape as askApproval — needs an open 24h window,
 * so only send when the agent has messaged the company number recently (which they
 * have if this fires right after they tapped an approval).
 */
export async function askVoiceConsent(to: string): Promise<void> {
  const apiKey = process.env.DIALOG360_API_KEY;
  const baseUrl = process.env.DIALOG360_API_URL;
  if (!apiKey || !baseUrl) throw new Error("DIALOG360_API_KEY and DIALOG360_API_URL must be set");
  if (!to) throw new Error("askVoiceConsent: destination (agent send_number) required");

  const res = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: { "D360-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: "Want me to learn your writing voice? I'll play a few leads at you, you reply as yourself, and my suggestions will start sounding like you.",
        },
        action: {
          buttons: [
            { type: "reply", reply: { id: "voice:start", title: "Yes, let's do it" } },
            { type: "reply", reply: { id: "voice:skip", title: "Not now" } },
          ],
        },
      },
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`360dialog voice-consent prompt failed (${res.status}): ${detail}`);
  }
}

/**
 * Ask the agent (company number) to set a newly-qualified lead's funnel stage, as a
 * WhatsApp interactive LIST message — one tappable row per pipeline value. Buttons
 * cap at 3, so a list (up to 10 rows) is the only shape that fits all 8 stages. Each
 * row id carries the phone + pipeline, so a tap is unambiguous and comes back as a
 * distinct list_reply type. `qualLine` is a short readback like "rent · 1BR · JVC ·
 * ~AED 80k/yr". No silent auto-move — the agent always taps. (360dialog mirrors
 * Meta's Cloud API list-message shape.)
 */
export async function askStage(
  to: string,
  phone: string,
  name: string | null,
  qualLine: string,
): Promise<void> {
  const apiKey = process.env.DIALOG360_API_KEY;
  const baseUrl = process.env.DIALOG360_API_URL;
  if (!apiKey || !baseUrl) throw new Error("DIALOG360_API_KEY and DIALOG360_API_URL must be set");
  if (!to) throw new Error("askStage: destination (agent send_number) required");

  const who = name ? `${name} (+${phone})` : `+${phone}`;
  const rows = PIPELINES.map((p) => ({
    id: `stage:${phone}:${p}`, // comes back on tap — encode phone + pipeline
    title: PIPELINE_LABELS[p], // ≤24 chars (enforced by the label map)
  }));
  const res = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: { "D360-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: `${who} looks qualified (${qualLine}). Set their stage:` },
        action: {
          button: "Choose stage",
          sections: [{ title: "Pipeline", rows }],
        },
      },
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`360dialog stage prompt failed (${res.status}): ${detail}`);
  }
}
