# HANDOFF — Phase 10: qualification-complete → agent stage prompt (list message)

Date: 2026-07-23
Branch: master

## TL;DR

This session **shipped the Control Center dashboard** (build plan wired end-to-end, verified live
against real Supabase) and **cleaned test junk out of the DB**. Then we designed — but did **NOT yet
build** — an auto-qualification gate. The gate design is the work for the NEXT session and is fully
specced below.

**What's DONE and verified this session:**
- Control Center dashboard (migration 002 + store + API + UI + WhatsApp `stage` command + auto
  `no_reply` reminder). Live end-to-end pass green. See "Done this session" below.
- Deleted 3 test leads (#1, #3, #4) + their 26 messages + 4 memory rows. DB now clean.

**What's DESIGNED, approved by user, NOT built (next session's job):**
- When a lead's core qualification fills up, the bot should DM the agent on the company number with a
  **WhatsApp interactive LIST message** offering all 8 pipeline stages as tappable rows. The agent
  taps one → system registers it (`setPipeline`). **No silent auto-move** — the agent always taps.

Server is currently **stopped** (port 3000 free). Nothing running.

---

## Done this session (Control Center — all committed to working tree, NOT git-committed)

Files touched/created:
- `supabase/migrations/002_add_pipeline.sql` (new) — `pipeline` column, 8-value CHECK. **RUN ON LIVE
  DB already** (user pasted it in the SQL editor this session; all rows backfilled to `'new'`).
- `supabase/schema.sql` — added `pipeline` column for fresh-project case.
- `src/store.ts` — `Pipeline` type + `PIPELINES` array, `pipeline` on `Lead`, `setPipeline()`,
  `listAgents()`, `leadsForBoard()` (adds live responsiveness badge).
- `src/api.ts` (new) — 5 routes: `GET /api/agents`, `GET /api/agents/:id/board`,
  `GET /api/leads/:id`, `GET /api/leads/:id/messages`, `POST /api/leads/:id/pipeline`. Service-role
  store only; validates pipeline against the 8 values.
- `src/server.ts` — mounts `apiRouter`; serves `mockups/control-center.html` at `GET /`.
- `src/company.ts` — `parseStageCommand()` + `handleStageCommand()` for typed `stage <phone> <value>`;
  wired into the POST chain (approval → stage command → Q&A).
- `src/reminders.ts` — daily tick auto-demotes silent leads to `no_reply`, **only** from
  `new`/`qualifies`/`details_sent` (never clobbers `eoi`/`deal_closed`/`waste`).
- `mockups/control-center.html` — hardcoded `AGENTS` replaced with `fetch()` to the API; canonical
  pipeline keys; refresh buttons + "loaded Xm ago" stamps; stage dropdown on lead detail; chat stays
  read-only. (Dropped the mockup's Email field — no email column in the store — replaced with Area.)
- `scripts/stagelogic.test.ts` (new) — offline parser test; added to `test:logic` in `package.json`.

Verified: `npm run typecheck` clean; `npm run test:logic` all pass; live smoke test hit real Supabase
— `/`, all API routes 200, invalid-pipeline write → 400, `setPipeline` round-trip
(`new → meeting_done → new`) confirmed and restored.

---

## DB data-state facts (Supabase) — CURRENT as of end of this session

This **supersedes** the data-state notes in phase 9's handoff.

Leads for `agent_demo` (7 → now 4 rows after cleanup):
- **#13 Madhur** `919717662666` — `monitor: approved`, `pipeline: new`, `stage: deep`. **The one real
  lead on the board.** Qualification is ~90% clean (see below).
- **#12 Nina** `33781692289` — `rejected` (hidden from board).
- **#14 Vruttant Mankad** `918511125354` — `rejected` (hidden).
- **#15 Anju** `919811923808` — `rejected` (hidden).

**Deleted this session** (were test/loop junk, user confirmed not real leads):
- #1 `971500000001` (Demo Lead), #3 `971581137568` (self-loop residue — 21 nested bot-card echoes),
  #4 `971582941441` (Dennis Kobe / "Mitko contact" test). Deleted rows + their **26 messages** +
  **4 memory rows**, children first (FK order). The phase-9 "26 orphaned message rows" note is now
  RESOLVED — they're gone.

### Madhur's qualification — what's stored (the motivating example)
- `area` = `JVC` ✅
- `summary` = full, accurate (1BR rental, JVC, near Circle Mall, sunlit pool, Nov 1 move-in, impatient) ✅
- `memory` = 5 clean fact rows ✅
- `replies_json` = 4 good suggested replies ✅
- `requirement` = `"rent · 1-bedroom rental property · Not explicitly stated, but assumed from '1 bed'"`
  — has a trailing reasoning fragment (minor leak).
- **`budget` = BROKEN** — holds the model's chain-of-thought verbatim:
  `"There is no concrete budget stated. However, the lead mentions an 'ideal' of around 80k per
  year... I will record this as a range: [6670, 80000]."` Should be a clean value like `~AED 80k/yr`.

Two stage columns exist and are BOTH correct-by-design (do not "reconcile" them):
- `stage` (`first_contact`/`following_up`/`deep`) = conversation depth, drives reply TONE in
  `replies.ts`. Internal, never shown on the dashboard. Madhur = `deep`.
- `pipeline` (8 values) = sales funnel, shown on the board. Madhur = `new`.

---

## NEXT SESSION — the work to build (designed + user-approved, NOT built)

**Goal:** when a lead's core qualification is complete, the bot DMs the agent a WhatsApp **list
message** with all 8 stages; the agent taps a stage; the system writes it via `setPipeline`. No silent
auto-move — user was explicit: the agent always confirms by tapping.

### The insight that makes this small
`src/qualify.ts` ALREADY extracts the sub-fields you need. Its internal `RawQualification` has
`transaction` (rent/buy), `property_type`, `bedrooms` — it just calls `joinRequirement()` to mash them
into one `requirement` string and THROWS THE PARTS AWAY (`qualify.ts:67`, returned at `:89-94`). So the
5 criteria (budget, area/location, rent-or-buy, unit type, beds) already come out of the model. We
stop discarding them.

### User's 5 qualification criteria → columns
| Criterion | Column | Source in qualify.ts today |
|---|---|---|
| budget | `budget` (exists) | `raw.budget` (but dirty — see guard) |
| location | `area` (exists) | `raw.area` |
| rent or buy | `deal_type` (NEW) | `raw.transaction` |
| unit type (apt/townhouse/villa) | `unit_type` (NEW) | `raw.property_type` |
| beds | `beds` (NEW) | `raw.bedrooms` |

"Fully qualified" = all 5 non-null.

### Build steps

**1. Migration — `supabase/migrations/003_add_qual_fields.sql` (new)**
- `alter table leads add column if not exists deal_type text;`
- `... unit_type text;`
- `... beds text;`
- All nullable, no default (null = not yet captured). Mirror into `schema.sql`.
- User runs it in the Supabase SQL editor (same as 001/002 — migrations are applied by hand here,
  there is NO migration runner script). **Don't run `schema.sql` on live — it drops tables.**

**2. `src/qualify.ts`**
- Add `deal_type`/`unit_type`/`beds` to the returned `Qualification` interface, populated from
  `raw.transaction`/`raw.property_type`/`raw.bedrooms`. KEEP `requirement` (card + replies read it).
- **Fix the dirty-budget bug** with a guard: after extraction, if `budget` looks like prose/reasoning
  rather than a value, null it. Cheap heuristic — e.g. reject if length > ~40 chars OR matches
  `/there is no|i will record|to maintain|assume|translates to/i`. A real budget ("AED 80k/yr",
  "1.4M", "8k/month") passes; a paragraph fails → null → the next-question logic re-asks it.
  Leave ONE runnable assert-based self-check for this guard (ponytail rule).

**3. `src/store.ts`**
- Add `deal_type`/`unit_type`/`beds` to the `Lead` interface.
- Persist them in `updateLeadQualification()`, sticky (same "omit-null-key = COALESCE" pattern already
  used for budget/area/requirement at `store.ts` ~line 137). So a null pass never wipes a known value.

**4. `src/notify.ts` — new `askStage(phone, name, qualLine)`**
- Send a WhatsApp **interactive list** message (NOT buttons — buttons cap at 3, we need all 8).
  Shape mirrors `askApproval()` but `type: "interactive"` → `interactive.type: "list"`.
- Body text ≈ `"${who} looks qualified (${qualLine}). Set their stage:"` where `qualLine` is e.g.
  `"rent · 1BR · JVC · ~AED 80k/yr"`.
- `action.button` = a short label like "Choose stage".
- `action.sections[0].rows` = 8 rows, one per pipeline value. Each row:
  `{ id: "stage:<phone>:<pipeline>", title: "<Label>", description?: "" }`. Row `title` max 24 chars —
  the labels fit ("Details sent", "Deal closed", etc.). Reuse `PIPELINE_LABELS` from `company.ts`
  (export it, or duplicate the small map).
- 360dialog mirrors Meta's Cloud API list-message shape. Confirm the exact JSON against 360dialog docs
  before wiring — list messages are pickier than buttons (section/row required fields).

**5. `src/brain.ts`**
- Reuse the EXISTING `wasQualified` signal at `brain.ts:117`
  (`lead.budget !== null && lead.area !== null && lead.requirement !== null`). Extend the notion of
  "qualified" to the 5 fields for THIS purpose (compute a `nowQualified` from q.budget/area/deal_type/
  unit_type/beds all non-null).
- After `updateLeadQualification`, fire `askStage(...)` **once**, only when:
  `!wasQualified && nowQualified && lead.pipeline === 'new'`.
  This fires exactly on the turn qualification first completes, so NO separate "already asked" flag is
  needed (same trick the listings fetch already uses at `:117-121`). A lead already moved off `new`
  never gets prompted.
- Note: `wasQualified` currently checks 3 fields; decide whether the 5-field `nowQualified` should also
  gate the listings fetch, or keep listings on the old 3-field check. SAFEST: leave listings on the
  existing 3-field `wasQualified`, add a SEPARATE 5-field check just for `askStage`. Don't entangle them.

**6. `src/company.ts` — handle the tapped list row**
- Add a `handleStageSelection(msg)` sibling to `handleApproval()`. A list tap arrives as
  `msg.type === "interactive"`, `msg.interactive.type === "list_reply"`,
  `msg.interactive.list_reply.id === "stage:<phone>:<pipeline>"`.
- Parse it (new exported `parseStageSelection(id)` — trust boundary, guard phone `/^\d{6,15}$/` and
  pipeline ∈ PIPELINES, like `parseApprovalId`). Resolve phone → lead via `findLeadByPhone`, call
  `setPipeline`, return a `✓ +<phone> → <Label>` confirm DM.
- Wire into the POST chain BEFORE the text branch: try approval (button_reply) → try stage selection
  (list_reply) → then text (stage command / Q&A). All three interactive/text types are distinct so
  they never collide.

### Verification (next session)
1. `parseStageSelection` self-check (`scripts/*.test.ts`, mirror `stagelogic.test.ts`). Add to
   `test:logic`.
2. Budget-guard self-check (assert the dirty paragraph → null, a real value → kept).
3. `npm run typecheck` + full `npm run test:logic`.
4. Live: simulate a company-number `list_reply` inbound with id `stage:919717662666:qualifies` →
   confirm Madhur moves to `qualifies` and the `✓` DM fires.
5. Live qualify path: send Madhur (or a fresh test lead) enough messages to fill all 5 fields → confirm
   the list prompt DM arrives ONCE, and that `budget` now stores clean (not the reasoning paragraph).

### Open question left for the builder
- Madhur is already `new` with all fields *except* a clean budget. After the budget guard ships, his
  budget only re-cleans on his NEXT inbound message (qualify runs per-inbound, not retroactively). If
  you want him correct immediately, one-off UPDATE his `budget` cell in the SQL editor
  (`update leads set budget='~AED 80k/yr' where id=13;`) — otherwise it self-heals on next message.

### Guardrails (unchanged from build plan)
- Do NOT touch `stage` / `deriveStage()` / reply tone. New fields are additive.
- Board + counts stay filtered to `monitor='approved'`.
- No Supabase creds in the browser.
- No silent auto-move — agent taps to set every stage past `new`.

---

## Env / running notes (carried from prior handoffs)
- Migrations run by hand in the Supabase SQL editor. No runner script. `schema.sql` DROPS tables —
  never run it on live.
- `COMPANY_BOT_NUMBER=971581137568` in `.env` — the self-loop guard (phase 9) depends on it.
- `npm run start` boots server + Baileys + reminder tick. Reminder tick now WRITES (auto-`no_reply`) —
  it runs once on boot, so booting touches live pipeline data for silent leads. Fine, but be aware.
- Dashboard: `npm run start` → `http://localhost:3000/`.
