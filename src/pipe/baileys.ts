import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import pino from "pino";
import { handleAgentMessage } from "../brain.js";
import type { AgentMessageEvent } from "./types.js";

// This pipe READS the agent's own WhatsApp number (unofficial Baileys link) and
// feeds every text into the brain as a normalized AgentMessageEvent. The brain
// never learns it came from Baileys — a 360dialog webhook can replace this file
// later with zero brain changes.

const AGENT_ID = process.env.AGENT_ID ?? "agent_demo";
const AUTH_DIR = process.env.BAILEYS_AUTH_DIR ?? "./baileys_auth";

// On reconnect Baileys can replay old messages carrying their ORIGINAL send time.
// We already ignore history-sync batches (type !== "notify"), but a live re-delivery
// after a long outage could still be stale — drop anything older than this so a
// prior session's chatter doesn't reappear mid-conversation.
// ponytail: fixed 10-min window; widen if a session legitimately goes quiet longer.
const STALE_MS = 10 * 60 * 1000;

// A reconnect re-runs startBaileys and can leave two live upsert listeners briefly,
// and Baileys itself re-delivers a message on a slow ack — either way the SAME waId
// hits the brain twice and the agent gets two cards. The brain's DB dedup can't stop
// it (both reads see "not saved yet" before either writes — a race), so we gate on
// waId here, in-process, before handing off. Bounded so it can't grow unbounded.
// ponytail: in-memory set, cleared past a cap; fine for one agent's message volume.
const seenWaIds = new Set<string>();
function alreadyHandled(waId: string | undefined): boolean {
  if (!waId) return false; // no id to dedup on (e.g. outbound/simulated) — let it through
  if (seenWaIds.has(waId)) return true;
  if (seenWaIds.size > 1000) seenWaIds.clear(); // crude bound; order doesn't matter here
  seenWaIds.add(waId);
  return false;
}

/** Strip the WhatsApp JID suffix to the bare E.164 digits: "9715...@s.whatsapp.net" → "9715...". */
export function jidToNumber(jid: string): string {
  return jid.split("@")[0].split(":")[0];
}

/** Pull plain text from a message, or "" if it carries none (media, reaction, etc.). */
export function messageText(msg: WAMessage): string {
  const m = msg.message;
  return m?.conversation ?? m?.extendedTextMessage?.text ?? "";
}

/**
 * Turn a Baileys message into the brain's event shape, or null if it isn't a
 * lead text we should process: group chats, status broadcasts, and non-text all
 * drop out here so the brain only ever sees 1:1 text with a lead.
 */
export function toEvent(msg: WAMessage): AgentMessageEvent | null {
  const jid = msg.key.remoteJid ?? "";
  // Only 1:1 personal chats. WhatsApp now addresses these two ways: the classic
  // "<number>@s.whatsapp.net" and the newer opaque "<id>@lid" (privacy linked-id).
  // Accept both; reject groups (@g.us) and status (@broadcast).
  const isDirect = jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
  if (!isDirect) return null;

  // On a @lid message the remoteJid is NOT the phone number — the real E.164 is on
  // key.senderPn ("<number>@s.whatsapp.net"). Prefer it so the lead is keyed by
  // phone, not the opaque lid. Falls back to the jid's own digits if it's absent.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const senderPn = (msg.key as any).senderPn as string | undefined;
  const leadNumber = jidToNumber(senderPn ?? jid);

  const text = messageText(msg).trim();
  if (!text) return null; // non-text (media/reaction/etc.) — text-only first cut

  return {
    agentId: AGENT_ID,
    leadNumber, // counterpart's phone (from senderPn on @lid), the lead in both directions
    direction: msg.key.fromMe ? "out" : "in", // fromMe = the agent typed it
    text,
    timestamp: Number(msg.messageTimestamp) * 1000,
    waId: msg.key.id ?? undefined,
    leadName: msg.pushName ?? undefined,
  };
}

/**
 * Connect to the agent's WhatsApp via Baileys, persist auth so the QR is scanned
 * once, auto-reconnect on drops, and feed each live text message into the brain.
 */
export async function startBaileys(): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }), // Baileys is chatty; we log our own events
    printQRInTerminal: false, // deprecated in-lib; we render it ourselves below
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("[baileys] scan this QR with the agent's WhatsApp (once):");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      console.log("[baileys] connected");
    }
    if (connection === "close") {
      const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      // Every drop reconnects EXCEPT a real logout — that invalidates the saved
      // creds, so the only fix is a fresh QR scan (delete AUTH_DIR and restart).
      if (loggedOut) {
        console.error("[baileys] logged out — delete", AUTH_DIR, "and restart to re-scan the QR");
      } else {
        console.warn("[baileys] connection closed, reconnecting...");
        startBaileys().catch((e) => console.error("[baileys] reconnect failed:", e));
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // "notify" = arrived live while online. "append"/history-sync batches carry
    // the old backlog — ignore them so restarts don't re-process past chats.
    if (type !== "notify") return;

    for (const msg of messages) {
      const ev = toEvent(msg);
      if (!ev) continue;
      // Belt-and-suspenders on top of the notify filter: a live re-delivery after
      // a long outage still carries its original timestamp — skip if too old.
      if (Date.now() - ev.timestamp > STALE_MS) {
        console.warn(`[baileys] dropping stale message (${ev.waId}) from ${ev.leadNumber}`);
        continue;
      }
      // Same message twice (stacked listener after a reconnect, or a Baileys
      // re-delivery) — process it once so the agent gets one card, not two.
      if (alreadyHandled(ev.waId)) {
        console.warn(`[baileys] duplicate message (${ev.waId}) from ${ev.leadNumber} — skipping`);
        continue;
      }
      console.log(`[baileys] ${ev.direction} from ${ev.leadNumber} (${ev.leadName ?? "?"}): "${ev.text}" — handing to brain...`);
      try {
        await handleAgentMessage(ev);
      } catch (e) {
        console.error("[baileys] handleAgentMessage failed:", e);
      }
    }
  });

  return sock;
}
