-- Layer 2C: in-WhatsApp voice interview. Holds the multi-turn state of an agent's
-- self-serve voice onboarding on the company number. null/absent = no interview in
-- progress (the normal state). Shape:
--   { "phase": "awaiting_consent" | "interviewing",
--     "step": <0-based index into the scenario list>,
--     "replies": ["<agent reply 1>", ...] }   -- captured verbatim, extracted into the card at wrap
-- Cleared (set null) once the card is saved. Lives on agent_persona so one row per
-- agent carries both the card and any in-flight interview — no extra table.
alter table agent_persona
  add column if not exists interview_state jsonb;
