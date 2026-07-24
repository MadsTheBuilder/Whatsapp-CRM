# HANDOFF — Phase 13: Distill job verified live + @lid outbound-capture fix (partial)

Date: 2026-07-24
Branch: master
Status: **Distill loop BUILT + PROVEN live. @lid pipe fix STARTED (types/pipe/store done, brain wiring NOT done). Next session: finish brain wiring, then live-test agent→client messages end-to-end.**

## The goal for next session (what we're testing)

Live prototype test: the agent sends **4 messages to a client (Madhur, a @lid contact)** from
their own phone, and we confirm the brain picks them up, stores them, the distill fires at the
threshold, and the voice card updates. This currently FAILS at one remaining spot — the brain
doesn't resolve @lid leads yet (see "What's left" below). Finish that, then run the test.

## What was proven this session (distill loop works)

Ran `scripts/distill-live.ts` against live Supabase + local model. All three checks passed and
were **independently confirmed in the DB**:
- `distill ran: YES` — threshold gate fired at 4 samples (DISTILL_THRESHOLD=4 for the test)
- `card_upto advanced: 0 → 43` — watermark moved to the last folded message id
- `card changed: YES` — card rewritten from the folded messages (len 2158 → 1679)
- `agent_persona_versions` got one row: `from_upto:0, to_upto:43, sample_count:4` (audit log works)
- Rollback proven: the original 2158-char seed was recoverable from `prior_card` in the version log.

So the distill CODE (store.ts helpers, distill.ts, brain.ts trigger, migration 006, version log,
self-imitation filter, batch cap) is complete and correct. The only thing blocking the LIVE
agent→client test is the @lid read-pipe gap.

## The @lid problem (why the live test failed before)

Full write-up: [../wa_plan/lid-outbound-capture-PROBLEM.md](../wa_plan/lid-outbound-capture-PROBLEM.md).

Short version: WhatsApp shows some contacts as an opaque `<id>@lid` instead of a phone number.
On INBOUND we get the phone (in `key.senderPn`); on OUTBOUND we get only the lid, no phone. Our
leads are keyed by phone, so the agent's outbound messages to a @lid contact (Madhur is one, lid
`7232909500553`, confirmed STABLE across messages) were dropped before the brain — 0 stored, so
distill never saw them. This is a pre-existing pipe gap; the distill feature is just the first
thing that reads the outbound stream, so it surfaced it.

## The @lid fix — status: types/pipe/store DONE, brain NOT done

**Done (already in the tree, typechecks clean):**
- `supabase/schema.sql` — `leads.lid text` column + partial unique index `idx_leads_lid` on
  `(agent_id, lid) where lid is not null`. **NOT yet applied as a migration file / to live DB.**
- [src/pipe/types.ts](../src/pipe/types.ts) — `AgentMessageEvent.lid?: string`.
- [src/pipe/baileys.ts:91-113](../src/pipe/baileys.ts#L91-L113) — extracts the bare lid from a @lid
  jid, sets `lid` on the event in BOTH directions, no longer drops lid-with-no-senderPn.
- [src/store.ts](../src/store.ts) — `Lead.lid`, `findLeadByLid(agentId, lid)`, `setLeadLid(agentId,
  id, lid)` (writes only while lid is null, never thrashes).

**NOT done — THIS is the remaining work (the reason the live test still fails):**
The brain still resolves leads by phone only. [src/brain.ts:52](../src/brain.ts#L52):
```
let lead = await findLeadByPhone(ev.agentId, ev.leadNumber);
```
For an outbound @lid message, `ev.leadNumber` is the lid digits, so this misses, the lead falls
into the "new number" branch, and a junk pending lead keyed by the lid-as-phone is created — the
message is dropped, distill never runs. `findLeadByLid`/`setLeadLid` exist but nothing calls them.

### What to wire in the brain (handleAgentMessage, near line 52)

1. **Resolve by lid when present:** if `ev.lid` is set, look the lead up by lid FIRST
   (`findLeadByLid`), falling back to `findLeadByPhone(ev.leadNumber)` when there's no lid.
   Rough shape:
   ```
   let lead = ev.lid
     ? await findLeadByLid(ev.agentId, ev.lid)
     : await findLeadByPhone(ev.agentId, ev.leadNumber);
   if (!lead && ev.lid == null) lead = await findLeadByPhone(...); // classic path unchanged
   ```
2. **Cold outbound = drop (decided last session).** If it's an OUTBOUND @lid message and no lead
   is found (contact never messaged inbound, so no phone + no stored lid), DROP it — do not create
   a pending lead, do not prompt. Nothing to learn from a one-way blast. Only a lead with a prior
   inbound (which gave us phone+lid) can receive outbound-distill.
3. **Learn the lid on inbound:** when an INBOUND @lid message resolves/creates a lead (we have both
   phone via senderPn AND the lid), call `setLeadLid(agentId, lead.id, ev.lid)` so future outbound
   @lid messages resolve to the same lead. This is what links the two directions — without it,
   inbound is phone-keyed and outbound is lid-keyed and they never meet.

Keep the pipe-agnostic seam: the brain resolves via store helpers; it doesn't learn about Baileys.
The approval gate still applies (a @lid lead must be approved like any other).

### Migration still needed
`schema.sql` has the `lid` column + index, but there's **no `007_*.sql` migration file yet** and
the live DB doesn't have the column. Create `supabase/migrations/007_add_lead_lid.sql` with:
```sql
alter table leads add column if not exists lid text;
create unique index if not exists idx_leads_lid on leads (agent_id, lid) where lid is not null;
```
and apply it by hand in the Supabase SQL editor before the live test.

## Environment state (prototype — restore before prod)

- `.env`: `DISTILL_THRESHOLD=4` (set low for testing; restore to 20 or delete the line for prod).
- `.env`: `PORT=3001` (moved off 3000; the dashboard/webhook server now runs on 3001).
- `.env`: `MODEL=gemma4:12b` — REAL and installed (earlier guesses that it was a bogus tag were
  wrong). It is just SLOW: a bare "pong" took **78 seconds**. A full card fold takes minutes, so
  `distill-live.ts` and any live distill will blow past a 120s shell timeout — run distill checks
  in the background or expect a long wait. Consider a faster `REPLY_MODEL` for testing.
- Baileys auth: re-scanned this session (old session logged out). Don't open WhatsApp Web on the
  same number while Baileys is connected — that caused the logout.

## Live-test runbook (once brain wiring + migration 007 are done)

1. Apply migration 007. Restart server (`npm start`, port 3001). Confirm `[baileys] connected`.
2. From the agent's phone, have the CLIENT (Madhur) send 1 message IN first — this teaches the
   lead its lid (step 3 of the brain wiring). Approve the lead (Yes on the prompt) if new.
3. Agent sends 4 messages to Madhur. Watch the console:
   - `[baileys:diag] toEvent ... fromMe=true isLid=true` for each (the diag line is kept on purpose)
   - `[brain] stored out-msg for ...` (NOT a drop/duplicate line)
   - `[distill] agent_demo skipped: N/4` climbing, then `[distill] agent_demo saved: folded 4 ...`
     (the save log may lag minutes behind due to the slow model).
4. Verify in Supabase (or `npx tsx scripts/checkdistill.ts`): outbound count = 4, a new
   `agent_persona_versions` row with `sample_count:4`, `card_upto` advanced, card changed.

## Files touched this session

- NEW `src/distill.ts`, `supabase/migrations/006_add_agent_persona_versions.sql`,
  `scripts/distill.test.ts` (in `test:logic`).
- MODIFIED `src/store.ts` (distill helpers + normalized filter + batch cap + lid helpers),
  `src/brain.ts` (distill trigger — but NOT the lid resolution yet), `src/pipe/baileys.ts`
  (lid extraction + diag), `src/pipe/types.ts` (lid field), `supabase/schema.sql` (persona
  versions + lid column/index), `package.json` (test), `.env`/`.env.example` (threshold, port),
  `.claude/skills/voice-extraction-role-play/SKILL.md` (seed sets card_upto = max outbound id).
- PLANS: `wa_plan/voice-card-distill-job-PLAN.md` (reviewed), `wa_plan/lid-outbound-capture-PROBLEM.md` (new).
- THROWAWAY scripts still on disk: `scripts/distill-live.ts`, `scripts/checkdistill.ts`,
  `scripts/distill-cleanup.ts`, `scripts/checkprior.ts`, `scripts/modelping.ts`. Keep the first
  three for continued distill testing; `checkprior`/`modelping` were one-offs, safe to delete.

## Loose ends / cleanup not yet run

- **DB test residue:** the live test left test lead `000distilltest` (id 19) + 8 outbound messages,
  and the distilled card is currently the TERSE TEST voice, not the real seed.
  `scripts/distill-cleanup.ts` is written to fix this (deletes the test lead/messages/version rows
  and RESTORES the real 2158-char seed from `prior_card`, sets card_upto to real max-outbound-id).
  **It was NOT run yet — run it first next session** so the real voice card is restored before the
  live test. `npx tsx scripts/distill-cleanup.ts`.
- Two `ponytail: diag` log lines are intentionally KEPT in baileys.ts (the `toEvent` line and the
  per-event line) to verify the lid path live — remove them once the @lid fix is confirmed.

## Next session should start with
1. `npx tsx scripts/distill-cleanup.ts` (restore real seed, clear test residue).
2. Wire the lid resolution into `handleAgentMessage` (3 changes above) + `tsc` + `npm run test:logic`.
3. Create + apply migration 007.
4. Run the live agent→client 4-message test per the runbook.
