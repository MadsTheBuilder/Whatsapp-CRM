# Personal Data Breach Response Procedure (#7)

**Legal basis:** PDPL (Federal Decree-Law No. 45 of 2021) **Article 9**, as
detailed by the Executive Regulations (Cabinet Decision No. 111 of 2023).

> **Draft — not legal advice.** The 72-hour timeline and content requirements
> below reflect the current PDPL + Executive Regulations position, but confirm
> the exact notification channel and any sector overlay with a UAE lawyer before
> relying on this in a live incident.

## What the law requires (plain summary)

Under **Art. 9**, when a personal data breach occurs that could prejudice the
privacy or confidentiality of a data subject:

- The **controller** must notify the **UAE Data Office (UDO)** without undue
  delay and, where feasible, **within 72 hours** of becoming aware.
- Where the breach poses a risk to the data subject, they must also be notified
  in clear language, within a reasonable timeframe.
- A **processor** must notify the **controller immediately** upon becoming aware
  — the processor does not notify the UDO directly.

## Who we are in this

Per [`data-roles-and-dpa.md`](data-roles-and-dpa.md), the intended structure is:
**each broker (agent) is the controller; this software is the processor.** So in
a breach, **our duty is to notify the affected broker(s) immediately** — they, as
controllers, notify the UDO and their leads. Until that split is signed with a
given broker, treat ourselves as controller and notify the UDO directly.

## What counts as a breach here

Any unauthorised access, disclosure, loss, or alteration of the personal data we
hold about leads — which includes their phone number, name, full conversation
transcript, and AI-inferred profile (budget, area, requirement, timeline).
Concrete examples for this system:

- The Supabase / Postgres `SUPABASE_SERVICE_ROLE_KEY` is leaked, committed, or
  exposed (it bypasses row security — one leaked key exposes every lead).
- The database is accessed by an unauthorised party, or a backup is exposed.
- Lead data is sent to the wrong recipient (e.g. a suggestion card DM'd to the
  wrong number).
- A third-party processor we use (LLM provider, hosting) reports a breach to us.

A **WhatsApp account ban** (Baileys) is an availability/operational incident, not
a personal-data breach — unless data was also exposed. Log it, but Art. 9 does
not apply on its own.

## The procedure

| Step | Who | Action | Deadline |
|------|-----|--------|----------|
| 1 | Whoever notices | Contain — rotate the leaked key, revoke access, take the affected surface offline. | Immediately |
| 2 | Incident owner (default: the developer/operator) | Assess scope: what data, how many leads, which brokers affected. Write it down. | Same day |
| 3 | Incident owner | **As processor:** notify the affected broker(s) immediately. **As controller:** notify the UDO. | **Within 72h of awareness** |
| 4 | Controller (broker, or us if no split signed) | If the breach risks the lead, notify affected leads in clear language. | Reasonable timeframe |
| 5 | Incident owner | Record the incident in the breach log (below). | Within 7 days |

## Notification content (Art. 9 / Exec. Regs)

The notification to the UDO (and the substance passed to a controller broker)
must include:

- **Nature and scope** — what data, how many records, how many data subjects.
- **Likely consequences** for the affected data subjects.
- **Cause** and how it was discovered.
- **Measures taken** to contain and mitigate.
- **Contact point** for follow-up (the DPO's details once a DPO exists — see
  [`dpia.md`](dpia.md)).

## Breach log

Keep a running log (this file's git history, or a table in `docs/compliance/`).
One row per incident:

| Date discovered | What happened | Data / leads affected | Brokers notified | UDO notified (Y/N + date) | Leads notified | Remediation |
|-----------------|---------------|-----------------------|------------------|---------------------------|----------------|-------------|
| _(none yet)_ | | | | | | |

## Prevention hooks already relevant

- The service-role key is the single biggest breach vector. Keep it out of the
  repo and out of client code; rotate on any suspicion.
- The retention job (fix #4) shrinks the blast radius — data that's been deleted
  can't be breached.
