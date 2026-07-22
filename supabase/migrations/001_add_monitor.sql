-- Approval gate (Dennis/Mitko problem): add the monitor column to an EXISTING
-- leads table without wiping data. schema.sql already includes this column for a
-- fresh project; run THIS only against a live table that predates the column.
--
-- Existing rows are backfilled to 'approved': anything already in the table was
-- a real lead from before the gate existed, so it stays monitored. New rows land
-- 'pending' (the column default) and go through the Yes/No prompt.
alter table leads
  add column if not exists monitor text not null default 'pending';

update leads set monitor = 'approved' where monitor = 'pending';
