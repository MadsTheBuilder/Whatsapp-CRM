/**
 * The one shape every read-pipe feeds the brain. Baileys emits it from its
 * `messages.upsert` event today; a 360dialog agent-number webhook emits the
 * same shape later. The brain never learns which pipe produced a message.
 */
export interface AgentMessageEvent {
  agentId: string; // which agent this lane belongs to; resolved at the door from the receiving number
  sendNumber: string; // where the bot sends this agent's help (suggestions/prompts); resolved at the door
  leadNumber: string; // the LEAD's E.164 number (conversation key), not the agent's
  direction: "in" | "out"; // "in" = lead→agent, "out" = agent→lead (the agent's own sent msg)
  text: string;
  timestamp: number; // ms epoch
  waId?: string; // provider message id for dedup (optional)
  leadName?: string;
  // Opaque WhatsApp "<id>@lid" contact id (bare digits), set when the chat is a
  // @lid chat, in BOTH directions. Undefined for classic @s.whatsapp.net chats.
  // On a lid-only outbound (no senderPn) leadNumber == lid, so the brain must
  // resolve by lid, not treat the lid digits as a phone.
  lid?: string;
}
