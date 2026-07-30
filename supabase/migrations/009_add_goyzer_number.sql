-- Strict sender-gate for the portal lead-relay. Goyzer (the lead aggregator) messages
-- the agent's number with a lead card; only messages from THIS number are allowed to
-- trigger the automated 3-template outreach. Any other "You have a new lead!"-shaped
-- message (e.g. a spoof) falls through to the brain as ordinary text.
-- null/absent = no relay for this agent (the card is never treated as a portal lead).
-- Bare digits, no '+', to match read_number/send_number normalization.
alter table agents
  add column if not exists goyzer_number text;
