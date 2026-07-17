import { MockBSP } from "./mock.js";
import { MetaCloudBSP } from "./meta.js";

/** The "add the number later" seam. Every send routes through this. */
export interface BSP {
  /** Send a WhatsApp text to `to` (E.164, no +). Resolves when accepted. */
  send(to: string, body: string): Promise<void>;
}

/** Pick the implementation from env. Switching providers = env change only. */
export function makeBSP(): BSP {
  const which = (process.env.BSP ?? "mock").toLowerCase();
  if (which === "meta") return new MetaCloudBSP();
  return new MockBSP();
}
