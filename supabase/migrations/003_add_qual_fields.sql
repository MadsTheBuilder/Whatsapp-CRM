-- Phase 10: capture the qualification sub-fields we already extract but discarded.
-- rent-or-buy / unit type / beds join budget + area to make the 5 qualification
-- criteria. All nullable, no default: null = not yet captured. Apply by hand in the
-- Supabase SQL editor (no runner script). schema.sql mirrors these for fresh projects.
alter table leads add column if not exists deal_type text;
alter table leads add column if not exists unit_type text;
alter table leads add column if not exists beds text;
