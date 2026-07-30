/**
 * The one narrow exception to "the bot never messages a lead" (CLAUDE.md): a
 * Goyzer lead-relay card. Goyzer (a lead aggregator) sits between the portals
 * (PropertyFinder/Bayut/Dubizzle) and WhatsApp — when a lead taps a listing's
 * WhatsApp button, Goyzer messages the LISTING AGENT's own number with a
 * structured card (not the lead directly). This detects that card, resolves the
 * lead's real phone off its Tracking Link, and relays three pre-approved
 * 360dialog Utility templates to the lead — verbatim third-party content, never
 * AI-generated. See wa_plan/portal-lead-outreach-PROBLEM.md and -PLAN.md.
 *
 * HARD RULE: every card carries two distinct URLs. The Tracking Link is
 * server-side plumbing ONLY (resolved here to get `phone`) and must never reach
 * outbound message content. The listing link (from `Notes`) is the only URL ever
 * allowed into a template variable. Keep them as separately-named values
 * end-to-end — never a shared `link` field.
 */

import { sendTemplate } from "../notify.js";
import { createPendingLead, findLeadByPhone, saveMessage, setMonitor, type Agent } from "../store.js";

const GOYZER_TEMPLATES = {
  enquiryDetails: "listing_enquiry_details",
  agentIntro: "listin_agent_intro", // typo kept deliberately — already approved under this name
  howCanIHelp: "listing_how_can_i_help",
} as const;

const TEMPLATE_LANGUAGE = "en";

interface GoyzerCard {
  trackingLink: string;
  leadSource: string;
  clientName: string | null;
  property: string | null;
  community: string | null;
  notes: string;
}

function field(text: string, label: string): string | null {
  const m = text.match(new RegExp(`${label}\\s*:\\s*(.+)`));
  return m ? m[1].trim() : null;
}

/** Detect Goyzer's lead-relay card shape and pull its labeled fields. Portal-
 *  agnostic by construction — matches on Goyzer's own card structure, never on
 *  any one portal's URL domain. Returns null if `text` isn't a Goyzer card. */
export function parseGoyzerCard(text: string): GoyzerCard | null {
  if (!/you have a new lead!/i.test(text)) return null;
  const trackingLink = field(text, "Tracking Link");
  if (!trackingLink) return null;

  return {
    trackingLink,
    leadSource: field(text, "Lead Source") ?? "the portal",
    clientName: field(text, "Client Name"),
    property: field(text, "Property"),
    community: field(text, "Community"),
    notes: field(text, "Notes") ?? "",
  };
}

/** Recover the lead's real phone from the Tracking Link's final landing URL, which
 *  is either `api.whatsapp.com/send?phone=...` (phone in the query string) or
 *  `wa.me/+<phone>` (phone in the path, real Bayut sample) — handle both shapes. */
export function extractPhoneFromRedirect(location: string, base: string): string | null {
  const url = new URL(location, base);
  const queryPhone = url.searchParams.get("phone");
  if (queryPhone) return queryPhone.replace(/\D/g, "");
  // wa.me/<phone> — phone is the whole pathname (leading slash, optional '+').
  const pathPhone = url.pathname.replace(/^\/\+?/, "");
  return /^\d{6,}$/.test(pathPhone) ? pathPhone : null;
}

async function resolveLeadPhone(trackingLink: string): Promise<string | null> {
  try {
    // Let fetch follow the whole redirect chain (tracking links often 301→302→wa.me);
    // res.url is the final landing URL. Manual single-hop would miss a multi-hop link.
    const res = await fetch(trackingLink);
    return extractPhoneFromRedirect(res.url, res.url);
  } catch (e) {
    console.error("[goyzer] tracking link fetch failed:", e);
    return null;
  }
}

/** Pull the plain property URL out of the free-text Notes field — "...interested
 *  in your property on {Portal}: {link}Ref: ...", no separator before "Ref:". The
 *  ONLY link ever allowed into a template variable. Returns null (never the
 *  tracking link) if no URL-shaped match is found. */
export function extractListingLink(notes: string): string | null {
  const m = notes.match(/https?:\/\/\S+?(?=Ref:|\s|$)/);
  return m ? m[0] : null;
}

function listingName(card: GoyzerCard): string {
  if (card.property && card.community) return `${card.property}, ${card.community}`;
  return card.property ?? "your enquiry";
}

/** Entry point called from the agent webhook, before the brain sees the message.
 *  Returns true if this was a Goyzer card (handled — caller must skip
 *  handleAgentMessage for this event), false if it's an ordinary message (caller
 *  proceeds as normal).
 *
 *  STRICT sender-gate: `sender` (the number the message came FROM) must equal the
 *  agent's configured `goyzer_number`. Only the real Goyzer number can trigger the
 *  automated outreach — a spoofed "You have a new lead!" from anyone else falls
 *  through to the brain as ordinary text (return false), never a template send. */
export async function maybeRelayPortalLead(agent: Agent, text: string, sender: string): Promise<boolean> {
  // Not from Goyzer → not a portal relay. Let the brain handle it as normal.
  if (!agent.goyzer_number || sender !== agent.goyzer_number) return false;

  const card = parseGoyzerCard(text);
  if (!card) return false;

  const leadPhone = await resolveLeadPhone(card.trackingLink);
  if (!leadPhone) {
    console.error("[goyzer] could not resolve lead phone from tracking link — dropping relay");
    return true; // matched the card shape; don't let the brain also process this raw text
  }

  // Idempotency: one lead phone = one relay. 360dialog retries webhooks, and the
  // template send has no built-in dedup — without this an already-relayed lead gets
  // all three templates re-sent on every retry/restart. The seed row (below) is the
  // durable marker: if it already exists, this card was handled. Keyed on the phone,
  // survives restarts (it's in Supabase, not the in-memory msg-id ring).
  // ponytail: this pre-check + the created-guard below cover sequential retries and
  // the seed race; two *simultaneous* first-time retries could still both send before
  // either seeds. The leads unique index makes only one seed win, but both sends fire.
  // Accept it — 360dialog retries are seconds apart, not concurrent. Add a per-phone
  // lock only if a live double-send is ever actually observed.
  const existing = await findLeadByPhone(agent.agent_id, leadPhone);
  if (existing) {
    console.log(`[goyzer] lead ${leadPhone} already relayed (lead ${existing.id}) — skipping duplicate send`);
    return true;
  }

  const listingLink = extractListingLink(card.notes);
  if (!listingLink) {
    console.error("[goyzer] could not extract listing link from Notes — dropping relay (never falling back to the tracking link)");
    return true;
  }

  // Record the ACTUAL template + params sent, not a hand-written guess at the body.
  // The real message the lead receives is the approved 360dialog template with these
  // params substituted; storing the guessed prose would make the audit grep pass
  // against fiction. Store "template(params)" so what's logged is what went out.
  const sent: { template: string; body: string }[] = [];
  const record = (template: string, params: string[]) =>
    sent.push({ template, body: `[${template}] ${JSON.stringify(params)}` });
  // Send from the AGENT's own 360dialog channel, not the company bot — CLAUDE.md: the
  // first relayed message goes out "from the listing agent's own number". Key + URL move
  // together (a number can live on a different 360dialog cluster). Fall back to the
  // company channel as a pair only if the agent key isn't set (keeps dev/test working).
  const senderKey = process.env.AGENT_DIALOG360_API_KEY || process.env.DIALOG360_API_KEY || "";
  const senderUrl = process.env.AGENT_DIALOG360_API_KEY
    ? process.env.AGENT_DIALOG360_API_URL || process.env.DIALOG360_API_URL || ""
    : process.env.DIALOG360_API_URL || "";
  try {
    const name = listingName(card);
    await sendTemplate(leadPhone, GOYZER_TEMPLATES.enquiryDetails, TEMPLATE_LANGUAGE, [name, listingLink], senderKey, senderUrl);
    record(GOYZER_TEMPLATES.enquiryDetails, [name, listingLink]);

    await sendTemplate(leadPhone, GOYZER_TEMPLATES.agentIntro, TEMPLATE_LANGUAGE, [agent.name ?? "your agent", card.leadSource], senderKey, senderUrl);
    record(GOYZER_TEMPLATES.agentIntro, [agent.name ?? "your agent", card.leadSource]);

    await sendTemplate(leadPhone, GOYZER_TEMPLATES.howCanIHelp, TEMPLATE_LANGUAGE, [], senderKey, senderUrl);
    record(GOYZER_TEMPLATES.howCanIHelp, []);
  } catch (e) {
    console.error(`[goyzer] template send failed after ${sent.length}/3 sent:`, e);
    // don't retry, don't roll back already-sent templates — the lead may have seen them
  }

  if (sent.length === 0) return true; // nothing went out; nothing to seed

  // Force-approve regardless of the normal new-contact gate — a Goyzer card is
  // confirmed proof of a real enquiry, so monitor status is irrelevant here.
  const { lead, created } = await createPendingLead(agent.agent_id, leadPhone, card.clientName ?? undefined);
  if (!created) {
    // Lost a race with a concurrent retry that seeded first — it owns the send/seed.
    console.log(`[goyzer] lead ${leadPhone} seeded concurrently (lead ${lead.id}) — not re-seeding`);
    return true;
  }
  await setMonitor(agent.agent_id, leadPhone, "approved");
  for (const { body } of sent) {
    await saveMessage(agent.agent_id, lead.id, "out", body);
  }
  console.log(`[goyzer] relayed ${sent.length}/3 templates to ${leadPhone} (${card.leadSource}), lead ${lead.id} force-approved`);
  return true;
}
