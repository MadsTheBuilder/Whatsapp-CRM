# Data Protection Impact Assessment + DPO note (#9)

**Legal basis:** PDPL (Federal Decree-Law No. 45 of 2021) **Article 21** (DPIA)
and **Article 10** (DPO), as detailed by the Executive Regulations (Cabinet
Decision No. 111 of 2023).

> **Draft — not legal advice.** This DPIA is a working assessment of the system
> as built. It must be finalised and signed off before multi-agent scale, and
> reviewed by a UAE-qualified data-protection lawyer. Keep it available to the
> UAE Data Office on request (Exec. Regs requirement).

## When these trigger

Both obligations switch on at **scale** — they are arguably *not* mandatory for a
single agent, but become mandatory as the platform serves multiple brokers,
because the processing then involves **large-scale systematic profiling**.

- **DPIA (Art. 21):** required *before* processing that poses high risk —
  large-scale sensitive data, **profiling, automated decision-making, or
  systematic monitoring**. This system profiles every lead automatically, so at
  multi-agent scale a DPIA is required before go-live.
- **DPO (Art. 10):** required for large-scale sensitive-data processing, systematic
  profiling / automated decision-making, or ongoing behavioural monitoring. May be
  a contractor and need not be UAE-based, but **must be registered with the UAE
  Data Office** and must be independent.

Do the DPIA and retain a DPO **before broker #2**.

---

## DPIA

### 1. Description of the processing

| | |
|---|---|
| **Purpose** | Assist real-estate brokers by reading their WhatsApp lead conversations and privately generating suggested replies, lead summaries, and follow-up reminders for the broker. The bot never messages the lead. |
| **Data subjects** | The brokers' real-estate leads (members of the public who message a broker). |
| **Personal data** | WhatsApp phone number, name, full conversation transcript, and AI-inferred profile: budget, area, requirement, deal type, unit type, beds, timeline (see `supabase/schema.sql`). |
| **Nature of processing** | Automated ingestion of messages, storage in Postgres (UAE region), LLM-based qualification/profiling and reply drafting, summarisation, and DM of suggestions to the broker. |
| **Scale** | One broker initially; designed to scale to many (every row carries `agent_id`). Risk rating rises with broker count. |

### 2. Necessity and proportionality

- **Lawful basis:** consent/notice obtained by the broker (controller) via the
  first-reply consent line with STOP opt-out (fix #1). Absent that line, there is
  **no lawful basis** — this is the primary risk the DPIA exists to flag.
- **Data minimisation:** only text is processed; media/voice are dropped at the
  pipe. Profile fields are limited to what a broker needs to match a listing.
- **Purpose limitation:** data is used only to assist the broker, not for
  onward marketing to the lead (the bot never messages the lead — a hard rule).

### 3. Risks and mitigations

| Risk | Severity | Mitigation | Status |
|------|----------|------------|--------|
| Leads processed with no lawful basis / no notice (Art. 4, 5, 13) | **High** | Broker-sent consent line + STOP opt-out (fix #1) | ⬜ to build |
| Automated profiling without disclosure or objection route (Art. 18) | High | Same consent line discloses "an assistant tool helps me respond"; STOP = objection | ⬜ to build |
| Cross-border transfer to cloud LLM (Art. 22/23) | High | In-UAE inference (Ollama) by default; DB in AWS me-central-1 | 🟨 in progress |
| Indefinite retention (Art. 5) | Medium | 12-month retention job from last activity (fix #4) | ⬜ to build |
| No way to honour access/erasure (Art. 13–17) | Medium | In-system `deleteLead` function; documented request process | ⬜ to build |
| Service-role key leak exposes all leads | High | Key kept server-side, out of repo/client; rotate on suspicion; breach procedure (#7) | 🟨 partial |
| WhatsApp account ban via Baileys (operational, not PDPL) | High (to broker) | 360dialog only for real brokers; Baileys is dev-test only | 🟨 by policy |

### 4. Residual risk & sign-off

Residual risk is **acceptable once the ⬜ items are built and a controller/
processor DPA is signed per broker**. Until then, do not onboard a real broker at
scale.

- Assessed by: **[name]**  Date: **[date]**
- DPO review: **[name]**  Date: **[date]**
- Lawyer review: **[name]**  Date: **[date]**

*Update this DPIA whenever the system materially changes (new data field, new
sub-processor, new LLM provider, or cross-border transfer).*

---

## DPO note

Before broker #2:

1. **Appoint a DPO** — may be a contractor, need not be UAE-based, must be
   independent and free from conflict (cannot be dismissed for doing the role).
2. **Register the DPO** with the UAE Data Office (name, title, email, phone);
   keep it updated.
3. The DPO's contact becomes the follow-up point in the breach procedure (#7).
