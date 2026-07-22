/**
 * The one shape every read-pipe feeds the brain. Baileys emits it from its
 * `messages.upsert` event today; a 360dialog agent-number webhook emits the
 * same shape later. The brain never learns which pipe produced a message.
 */
export interface AgentMessageEvent {
  agentId: string; // which agent's number this came from (env AGENT_ID for now)
  leadNumber: string; // the LEAD's E.164 number (conversation key), not the agent's
  direction: "in" | "out"; // "in" = lead→agent, "out" = agent→lead (the agent's own sent msg)
  text: string;
  timestamp: number; // ms epoch
  waId?: string; // provider message id for dedup (optional)
  leadName?: string;
}
