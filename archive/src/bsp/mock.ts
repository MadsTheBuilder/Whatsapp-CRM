import type { BSP } from "./index.js";

/** Logs the outbound send. No number required — makes the whole demo run today. */
export class MockBSP implements BSP {
  async send(to: string, body: string): Promise<void> {
    console.log(`[MockBSP] → ${to}: ${body}`);
  }
}
