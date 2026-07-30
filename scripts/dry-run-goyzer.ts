// One-off DRY RUN for src/portal/goyzer.ts — safe to run with real Supabase/360dialog
// creds in .env, because it never imports notify.ts or store.ts (goyzer.ts's real
// sendTemplate/createPendingLead/setMonitor/saveMessage calls are never reached).
// Only exercises the pure detector/extractor exports, plus a real GET on the
// tracking link (harmless — reads a redirect, same as clicking the link would do;
// does not send anything or write to any database).
//
// Run: npx tsx scripts/dry-run-goyzer.ts
import "dotenv/config"; // MUST be first — store.ts (imported by goyzer.ts) throws at import if SUPABASE_* unset.
import { parseGoyzerCard, extractListingLink, extractPhoneFromRedirect } from "../src/portal/goyzer.js";

const SAMPLE = `Hi Mitko Parizov

You have a new lead!

Lead Source: Bayut
Campaign Name: NA
Tracking Link: https://ovation-live.bayut.com/ingest/conversations/buttonWebhook/?conversation_id=7437f99b-0956-4eda-bb48-f6c3f52bad1d&message_status=contact_lead

Client Name: cirstins cirstins
Client Phone # : Click On Tracking Link
Unit Reference # : AP26932
Property: Asayel 2
Community: Umm Suqeim
Unit details: NA

Notes: LeadId : 174936 Hi, I am interested in your property on Bayut: https://www.bayut.com/pm/15999972/180c884e-ca64-422d-ad3a-2adc4bd5d943Ref: AP26932L
Tracking Link : https://ovation-live.bayut.com/ingest/conversations/buttonWebhook/?conversation_id=7437f99b-0956-4eda-bb48-f6c3f52bad1d&message_status=contact_lead`;

const card = parseGoyzerCard(SAMPLE);
console.log("=== parseGoyzerCard ===");
console.log(card);

if (!card) {
  console.log("Did not detect as a Goyzer card — stopping.");
  process.exit(1);
}

const listingLink = extractListingLink(card.notes);
console.log("\n=== extractListingLink ===");
console.log(listingLink);

console.log("\n=== resolving tracking link (real network GET, no send, no DB) ===");
const res = await fetch(card.trackingLink, { redirect: "manual" });
const location = res.headers.get("location");
console.log("redirect location:", location);
const phone = location ? extractPhoneFromRedirect(location, card.trackingLink) : null;
console.log("resolved phone:", phone);

console.log("\n=== what WOULD be sent (sendTemplate calls, NOT actually called) ===");
const name = card.property && card.community ? `${card.property}, ${card.community}` : (card.property ?? "your enquiry");
console.log("1. listing_enquiry_details", [name, listingLink]);
console.log("   body: Thanks for your enquiry about", name + ":", listingLink + ". I will be helping you through the process");
console.log("2. listin_agent_intro", ["<agent.name>", card.leadSource]);
console.log("   body: Hi, this is <agent.name>. I got your enquiry via", card.leadSource, "on one of my listings.");
console.log("3. listing_how_can_i_help", []);
console.log("   body: How can I help you regarding this property?");

console.log("\n=== hard-rule check ===");
console.log("tracking link:", card.trackingLink);
console.log("listing link: ", listingLink);
console.log("equal? (must be false):", card.trackingLink === listingLink);
