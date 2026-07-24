-- Layer 2: per-agent voice card. Seeded by the voice-extraction role-play skill,
-- later folded on top by a distill job (not built yet). One markdown blob prepended
-- to every reply prompt so the model mirrors THIS agent's voice instead of a generic
-- one. null voice_card = generic fallback (cold start, zero regression). Apply by
-- hand in the Supabase SQL editor. schema.sql mirrors this.
create table if not exists agent_persona (
  agent_id   text primary key,
  voice_card text,                          -- markdown blob; null = generic fallback
  card_upto  bigint not null default 0,     -- watermark for the FUTURE distill job (unused now)
  updated_at timestamptz not null default now()
);
