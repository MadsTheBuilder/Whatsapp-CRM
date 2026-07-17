import type { BSP } from "./index.js";

/**
 * Real send via the Meta Cloud API (Graph API) messages endpoint. 360dialog
 * rides the same schema, so a 360dialog impl later is a third class with this
 * same interface. Selected by BSP=meta + META_* creds in .env.
 */
export class MetaCloudBSP implements BSP {
  private readonly phoneNumberId: string;
  private readonly token: string;

  constructor() {
    const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
    const token = process.env.META_TOKEN;
    if (!phoneNumberId || !token) {
      throw new Error(
        "BSP=meta requires META_PHONE_NUMBER_ID and META_TOKEN in .env",
      );
    }
    this.phoneNumberId = phoneNumberId;
    this.token = token;
  }

  async send(to: string, body: string): Promise<void> {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${this.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body },
        }),
      },
    );
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Meta send failed (${res.status}): ${detail}`);
    }
  }
}
