-- Sales pipeline stage — a SEPARATE column from `stage` (which is a 3-value
-- conversation-depth heuristic driving reply tone, not a sales funnel). Adding
-- pipeline here keeps the two concerns from colliding.
--
-- `default 'new'` backfills every existing row to 'new' — correct: a lead the
-- agent already had is at the top of the funnel until they move it. New leads
-- also land 'new' at insert (an approved lead defaults to the funnel start).
alter table leads
  add column if not exists pipeline text not null default 'new';

-- Restrict to the 8 funnel values — guards typos from the WhatsApp `stage`
-- command path (a free-text write) as defense in depth alongside the API check.
alter table leads
  drop constraint if exists leads_pipeline_check;
alter table leads
  add constraint leads_pipeline_check check (pipeline in (
    'new', 'no_reply', 'qualifies', 'details_sent',
    'meeting_done', 'eoi', 'deal_closed', 'waste'
  ));
