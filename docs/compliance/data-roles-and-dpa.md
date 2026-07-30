# Data Roles & Processing Agreement (#8)

**Legal basis:** PDPL (Federal Decree-Law No. 45 of 2021) **Article 1**
(controller/processor definitions) and **Article 8** (processor obligations), as
detailed by the Executive Regulations (Cabinet Decision No. 111 of 2023), which
make a **written Data Processing Agreement (DPA) mandatory** between controller
and processor.

> **Draft — not legal advice.** This is the decision plus a DPA skeleton. The
> binding DPA wording must be reviewed by a UAE-qualified data-protection lawyer
> before a broker signs it. This is the one item where a lawyer's edit is
> essential, not optional.

## The decision (the keystone)

The PDPL splits responsibility between two roles (**Art. 1**):

- **Controller** — decides *why* and *how* personal data is processed. Carries
  the heavy duties: lawful basis, notice, data-subject rights, breach reporting.
- **Processor** — processes data *on the controller's documented instructions*.
  Lighter, security-focused duties (**Art. 8**).

**Decision: each broker (agent) is the CONTROLLER of their own leads' data. This
software (the platform operator) is the PROCESSOR acting on that broker's behalf.**

### Why this is the right split

- The broker has the actual relationship with the lead. The lead is messaging the
  broker's WhatsApp; the broker is the natural party to give notice and obtain
  consent (the consent line in fix #1 goes out on the *broker's* number).
- It puts the lawful-basis / consent / notice duty on the party who can actually
  discharge it, and limits the platform's exposure to security + following
  instructions.
- Without this split, the platform is the **default controller for every
  broker's leads** — the heavy end of liability, for data it merely processes.

### Timing — critical

The DPA must exist **before broker #2 goes live**. The moment a second broker's
leads sit in the shared database under an undefined role, the platform is the
presumed controller for *all* of it, retroactively.

## Who does what under this split

| Duty | Controller (broker) | Processor (us) |
|------|---------------------|----------------|
| Lawful basis / consent for leads | ✅ | — |
| Notice to leads (Art. 13) | ✅ (via first-reply consent line) | provide the mechanism |
| Data-subject rights (access/erasure) | ✅ receives request | ✅ execute the deletion in-system |
| Security of the data (Art. 8, 20) | oversee | ✅ implement |
| Breach: notify UDO / leads | ✅ | notify the broker immediately |
| Cross-border transfer basis (Art. 22/23) | approve | keep processing in-UAE by default |
| Retention limits (Art. 5) | set the period | ✅ enforce via retention job |
| Records of processing (RoPA) | ✅ own | assist |

---

## DPA template (skeleton — lawyer to finalise)

**Data Processing Agreement**

Between **[Broker / Agent legal name]** ("Controller") and **[Platform operator
legal name]** ("Processor"), effective **[date]**.

**1. Subject matter and roles.** The Controller engages the Processor to process
personal data of the Controller's leads solely to provide the WhatsApp
lead-assistance service (reading the Controller's lead conversations, generating
suggested replies, summaries, and follow-up reminders for the Controller). The
Controller is the controller and the Processor is the processor under PDPL Art. 1.

**2. Scope of data.**
- *Categories of data subject:* the Controller's real-estate leads.
- *Categories of personal data:* WhatsApp phone number, name, conversation
  transcript, and AI-inferred profile (budget, area, requirement, deal type,
  unit type, beds, timeline).
- *No special/sensitive categories are intentionally processed.* The Controller
  instructs leads not to share sensitive data via the consent notice.

**3. Processor obligations (PDPL Art. 8).** The Processor shall:
- (a) process personal data only on the Controller's documented instructions,
  including for cross-border transfers;
- (b) ensure persons processing the data are bound by confidentiality;
- (c) implement appropriate technical and organisational security measures
  (Art. 20) — at minimum: access restricted to the service-role credential,
  credential kept out of client code and version control, and data held in a
  UAE region (AWS me-central-1) by default;
- (d) not engage a sub-processor without the Controller's prior authorisation
  (current sub-processors listed in Schedule A);
- (e) assist the Controller in responding to data-subject rights requests
  (access, erasure, restriction, objection) using the in-system deletion
  function;
- (f) notify the Controller **immediately** on becoming aware of a personal data
  breach (see [`breach-response.md`](breach-response.md));
- (g) at the end of the engagement, delete or return all personal data and delete
  existing copies, unless retention is legally required.

**4. Sub-processors (Schedule A).** Current sub-processors:
- Database/hosting: **[AWS me-central-1 / Supabase]**
- LLM inference: **[in-UAE model (Ollama) by default; any cloud LLM provider
  requires Controller authorisation and a lawful transfer basis under Art. 22/23]**
- WhatsApp connectivity: **[360dialog]**

**5. Cross-border transfer.** The Processor shall keep processing within the UAE
by default. Any transfer outside the UAE requires the Controller's authorisation
and a lawful basis under PDPL Art. 22–23.

**6. Retention.** Personal data is retained for **[12 months]** from last lead
activity, then deleted, unless the Controller instructs otherwise or an erasure
request is received sooner (see retention job, fix #4).

**7. Liability, term, governing law.** **[To be completed by legal counsel;
governed by UAE law.]**

---

*Fields in **[brackets]** are to be filled per broker. The technical facts
(data categories, sub-processors, retention window) are drawn from the live
system and the schema in `supabase/schema.sql`.*
