import type { BSP } from "./index.js";

/**
 * Real send via 360dialog's Cloud API hosting. Same Meta Graph API message
 * schema, different transport: base URL has no phone-number-id in the path
 * (the API key alone identifies the channel/number), and auth is a raw
 * D360-API-KEY header instead of `Authorization: Bearer`. Selected by
 * BSP=dialog360 + DIALOG360_* creds in .env.
 */
export class Dialog360BSP implements BSP {
  constructor() {
    if (!process.env.DIALOG360_API_KEY || !process.env.DIALOG360_API_URL) {
      throw new Error(
        "BSP=dialog360 requires DIALOG360_API_KEY and DIALOG360_API_URL in .env",
      );
    }
  }

  async send(to: string, body: string): Promise<void> {
    const baseUrl = process.env.DIALOG360_API_URL;
    const res = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: {
        "D360-API-KEY": process.env.DIALOG360_API_KEY!,
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
}
