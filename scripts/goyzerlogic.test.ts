// Offline self-check for the Goyzer portal-lead detector (src/portal/goyzer.ts):
// card detection, field extraction, and the listing-link-vs-tracking-link split.
// No network — supabase-js is lazy, so dummy creds let the module import without
// opening a connection. Run: npx tsx scripts/goyzerlogic.test.ts
import assert from "node:assert";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "dummy";

const { parseGoyzerCard, extractListingLink, extractPhoneFromRedirect } = await import("../src/portal/goyzer.js");

// Real Bayut lead captured live in phase19 (wa_session_log/HANDOFF-phase19-...).
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
assert(card, "the real Bayut sample must parse as a Goyzer card");
assert.equal(card!.leadSource, "Bayut");
assert.equal(card!.property, "Asayel 2");
assert.equal(card!.community, "Umm Suqeim");
assert.equal(card!.clientName, "cirstins cirstins");
assert.equal(
  card!.trackingLink,
  "https://ovation-live.bayut.com/ingest/conversations/buttonWebhook/?conversation_id=7437f99b-0956-4eda-bb48-f6c3f52bad1d&message_status=contact_lead",
);

// The listing link must come out of Notes, glued to "Ref:" with no separator —
// and must never be confused with the Tracking Link.
const listingLink = extractListingLink(card!.notes);
assert.equal(listingLink, "https://www.bayut.com/pm/15999972/180c884e-ca64-422d-ad3a-2adc4bd5d943");
assert.notEqual(listingLink, card!.trackingLink, "listing link must never equal the tracking link");

// Real PropertyFinder lead captured live in phase20 — confirms the same card shape
// across portals (the top residual risk from phase19/20). Note the differences from
// Bayut: listing link is a propertyfinder.ae/go/ short-redirect (not a direct pm/
// URL), it's space-separated in Notes (no glued Ref:), and the client name has an emoji.
const PF = `Hi Irfaan Mohammad

You have a new lead!

Lead Source: Propertyfinder
Campaign Name: NA
Tracking Link: https://www.propertyfinder.ae/leads/v1/lead/message/691A85Qo5EfGZGgIkur2pUQ/mjoFWLJp

Client Name: Bhav ☺️
Client Phone # : Click On Tracking Link
Unit Reference # : AP26241
Property: Icon Tower 2
Community: Jumeirah Lake Towers
Unit details: NA

Notes: LeadId : 163944 https://propertyfinder.ae/go/M58NKND7N0Z31STNGRFC9WPA6G`;

const pf = parseGoyzerCard(PF);
assert(pf, "the real PropertyFinder sample must parse as a Goyzer card");
assert.equal(pf!.leadSource, "Propertyfinder");
assert.equal(pf!.property, "Icon Tower 2");
assert.equal(pf!.community, "Jumeirah Lake Towers");
assert.equal(pf!.clientName, "Bhav ☺️");
assert.equal(
  pf!.trackingLink,
  "https://www.propertyfinder.ae/leads/v1/lead/message/691A85Qo5EfGZGgIkur2pUQ/mjoFWLJp",
);
const pfListing = extractListingLink(pf!.notes);
assert.equal(pfListing, "https://propertyfinder.ae/go/M58NKND7N0Z31STNGRFC9WPA6G");
assert.notEqual(pfListing, pf!.trackingLink, "PF listing link must never equal the tracking link");

// Ordinary agent<->lead chat must not be mistaken for a Goyzer card.
assert.equal(
  parseGoyzerCard("hey, are you still interested in the 2BR in JVC?"),
  null,
  "ordinary text must not match the Goyzer card shape",
);

// A message merely mentioning a portal by name, with no Tracking Link, isn't enough.
assert.equal(
  parseGoyzerCard("You have a new lead! Lead Source: Bayut, no link here though"),
  null,
  "a card missing Tracking Link must not match",
);

// Real Bayut sample's redirect target: phone lives in the PATH (wa.me/+<phone>),
// not a query string — this shape was missed until caught by a live dry run.
assert.equal(
  extractPhoneFromRedirect(
    "https://wa.me/+9779709715784?text=Hello%2C%20The%20team...",
    "https://ovation-live.bayut.com/ingest/...",
  ),
  "9779709715784",
  "wa.me path-style phone must resolve",
);

// api.whatsapp.com/send?phone=... shape (confirmed for a raw PropertyFinder link
// in phase18) — phone in the query string instead.
assert.equal(
  extractPhoneFromRedirect(
    "https://api.whatsapp.com/send?phone=971500000001&text=hello",
    "https://propertyfinder.ae/track/...",
  ),
  "971500000001",
  "api.whatsapp.com query-style phone must resolve",
);

assert.equal(
  extractPhoneFromRedirect("https://wa.me/", "https://x.example/"),
  null,
  "no digits in the path must not resolve to a phone",
);

console.log("goyzerlogic: all assertions passed");
