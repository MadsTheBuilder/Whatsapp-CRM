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

// The bot's OWN WhatsApp number. Its suggestion cards land on the agent's phone,
// which this pipe reads — so without this guard the bot reads back its own DMs as
// a "lead" message, qualifies them, and DMs another card: an infinite loop (each
// card nesting the last) plus cross-talk (replies referencing whatever was in that
// self-chat's memory). Drop the bot↔agent chat entirely; it's never a lead.
const COMPANY_BOT_NUMBER = process.env.COMPANY_BOT_NUMBER ?? "";

// On reconnect Baileys can replay old messages carrying their ORIGINAL send time.
// We already ignore history-sync batches (type !== "notify"), but a live re-delivery
// after a long outage could still be stale — drop anything older than this so a
// prior session's chatter doesn't reappear mid-conversation.
// ponytail: fixed 10-min window; widen if a session legitimately goes quiet longer.
const STALE_MS = 10 * 60 * 1000;

// Reconnect backoff. Without it, every "close" immediately re-ran startBaileys —
// a flapping link (same number on WhatsApp Web) spun hundreds of stacked sockets.
// Grows on each close, resets to MIN on a clean "open".
// ponytail: exponential backoff, no jitter; add jitter if many agents reconnect at once.
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
let reconnectDelay = RECONNECT_MIN_MS;

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

  // On a @lid message the remoteJid is NOT the phone — the real E.164 is on
  // key.senderPn ("<number>@s.whatsapp.net"), but ONLY on inbound. Outbound @lid
  // messages carry no senderPn, just the recipient's lid. The lid is stable per
  // contact, so we pass it through and let the brain resolve the lead by lid
  // (it learns the lid↔phone link from inbound, where both are present).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const senderPn = (msg.key as any).senderPn as string | undefined;
  const isLid = jid.endsWith("@lid");
  const lid = isLid ? jidToNumber(jid) : undefined;
  // ponytail: diag — keep while the lid-fallback path is verified live.
  console.log(`[baileys:diag] toEvent jid=${jid} fromMe=${msg.key.fromMe} isLid=${isLid} senderPn=${senderPn ?? "NONE"} text="${messageText(msg).slice(0, 40)}"`);
  // Phone from senderPn when present; else the lid digits stand in as the key, but
  // `lid` is set so the brain resolves by lid and never treats it as a phone.
  const leadNumber = jidToNumber(senderPn ?? jid);

  // The bot's own chat with the agent is not a lead — drop it, or the bot reads
  // back its own suggestion cards and loops. (Match on the bare number both ways.)
  if (COMPANY_BOT_NUMBER && leadNumber === COMPANY_BOT_NUMBER) return null;

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
    lid,
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

  // ponytail: diag — remove once inbound confirmed. Fires on EVERY baileys event so
  // we can tell a truly silent socket from one emitting receipts/presence but no msgs.
  sock.ev.process((events) => {
    console.log(`[baileys:diag] events: ${Object.keys(events).join(", ")}`);
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("[baileys] scan this QR with the agent's WhatsApp (once):");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      console.log("[baileys] connected");
      reconnectDelay = RECONNECT_MIN_MS; // a good connection resets the backoff
    }
    if (connection === "close") {
      const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      // Every drop reconnects EXCEPT a real logout — that invalidates the saved
      // creds, so the only fix is a fresh QR scan (delete AUTH_DIR and restart).
      if (loggedOut) {
        console.error("[baileys] logged out — delete", AUTH_DIR, "and restart to re-scan the QR");
      } else {
        // Back off before reconnecting so a flapping link (e.g. the same number
        // active on WhatsApp Web) can't spin a 200-close storm of stacked sockets.
        // The delay grows each close and resets on a clean "open".
        console.warn(`[baileys] connection closed code=${code} — reconnecting in ${reconnectDelay}ms`);
        const delay = reconnectDelay;
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
        setTimeout(() => {
          startBaileys().catch((e) => console.error("[baileys] reconnect failed:", e));
        }, delay);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // ponytail: diag — remove once inbound delivery confirmed. Shows raw upsert
    // before any filter, so a "no inbound" symptom tells us if events arrive at all.
    console.log(`[baileys:diag] upsert type=${type} count=${messages.length} jids=${messages.map((m) => m.key.remoteJid).join(",")}`);
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
