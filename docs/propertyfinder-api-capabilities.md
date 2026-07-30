# PropertyFinder Enterprise API — What It Can Do For Us

Source: https://api-docs.propertyfinder.net/enterprise-api/index.html

## Auth
- OAuth2 client-credentials style: `POST /v1/auth/token` with API key + secret → Bearer token.
- Token expires in **30 min**, no refresh token — must re-issue on expiry.
- Rate limits: 60 req/min on the token endpoint, 650 req/min everywhere else.
- Scopes gate access per resource (`leads:read`, `listings:read`, `webhooks:full_access`, etc).

## The part that matters for us: Leads

**`GET /v1/leads`** — paginated (max 50/page), filterable by `projectId`, `senderWhatsappUsername`, `listingSearch`.

Lead object:
- `id`, `listing.{id,reference}`, `message` (the enquiry text), `createdAt`/`updatedAt`, `responseLink`
- `sender.contacts[]` — array of `{type, value}`, type ∈ `phone` | `email` | `whatsappUsername`

**Webhooks** (push instead of polling): `lead.created`, `lead.updated`, `lead.assigned` → `POST` to our endpoint with the same lead payload shape. Subscribe via `POST /v1/webhooks`, remove via `DELETE /v1/webhooks/{eventId}`. Signature verification and retry policy aren't spelled out in the docs — treat delivery as best-effort and idempotent-safe on our end.

**No reply/send endpoint exists.** PropertyFinder is read-only for leads — there is no API to message a lead through PropertyFinder itself. `responseLink` just points to PropertyFinder's own inbox UI.

## Everything else available (not lead-related)
- Listings: create/update/delete/publish/unpublish, pricing, upgrades, verification/compliance checks
- Locations & projects lookup, floor plans
- Credits balance/spend/transactions
- Stats: profile performance, arena ranking, superagent stats
- User & public-profile management
- Other webhook events: `user.*`, `listing.published/unpublished/action/publishFailed`, `publicProfile.verification.*`

## What this means for our outreach automation

1. **Capture is real-time and automatable.** Subscribe to `lead.created` → the moment someone enquires on a listing, we get their name/phone/WhatsApp-username/message/which listing, no polling needed.
2. **The WhatsApp handoff is the whole play.** `sender.contacts[].type === "whatsappUsername"` (or `phone`) gives us exactly what we need to open a WhatsApp conversation — this slots straight into the existing `{agentId, leadNumber, direction, text, timestamp}` seam this project already uses. A new lead becomes: PropertyFinder webhook → normalize into that shape → treat as "first inbound message" → suggest an opening reply to the agent.
3. **We cannot auto-send anything through PropertyFinder** — same hard rule as the rest of this project (bot never messages the lead directly). The agent still has to be the one who opens WhatsApp and sends the first message, using PropertyFinder's `message` field (what the lead actually asked) as the seed for the bot's suggested opener.
4. **Polling fallback exists** if webhooks prove unreliable: `GET /v1/leads?senderWhatsappUsername=...` can reconcile/backfill.
5. Nothing here lets us skip the 3-day-old WhatsApp Business restriction — a fresh PropertyFinder lead is not yet a WhatsApp conversation the agent has permission to message into per template rules; the agent still has to initiate.
