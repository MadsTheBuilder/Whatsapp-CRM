import { readFileSync } from "node:fs";
import { parse } from "dotenv";
import type { BSP } from "./index.js";

// Re-read the token from .env on each send so a refreshed token takes effect
// without restarting the server. dotenv/config only loads .env once at boot,
// which is what caused the stale-token 401 (code 190). Falls back to
// process.env if .env can't be read (e.g. token set in the real environment).
function liveToken(): string | undefined {
  try {
    return parse(readFileSync(".env")).META_TOKEN || process.env.META_TOKEN;
  } catch {
    return process.env.META_TOKEN;
  }
}

/**
 * Real send via the Meta Cloud API (Graph API) messages endpoint. 360dialog
 * rides the same schema, so a 360dialog impl later is a third class with this
 * same interface. Selected by BSP=meta + META_* creds in .env.
 */
export class MetaCloudBSP implements BSP {
  constructor() {
    // Fail fast at boot if creds are missing, but read them per-send below so an
    // .env token refresh takes effect without restarting the server.
    if (!process.env.META_PHONE_NUMBER_ID || !process.env.META_TOKEN) {
      throw new Error(
        "BSP=meta requires META_PHONE_NUMBER_ID and META_TOKEN in .env",
      );
    }
  }

  async send(to: string, body: string): Promise<void> {
    const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
    const token = liveToken();
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
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
