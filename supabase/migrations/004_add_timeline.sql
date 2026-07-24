-- Personalized-reply rebuild: track the lead's stated move-in / buy timing.
-- Missing from qualify's field-set was why "November, contract ends then" got
-- re-asked by suggestReplies (the input-contract bug). Extracted passively (never
-- interrogated), passed to replies as an ANSWERED field. Nullable: null = not yet
-- stated. Apply by hand in the Supabase SQL editor. schema.sql mirrors this.
alter table leads add column if not exists timeline text;
