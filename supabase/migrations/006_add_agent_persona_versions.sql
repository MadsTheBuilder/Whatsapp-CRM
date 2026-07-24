-- Layer 2B: audit log for voice-card changes. The card is behavioral config that
-- rides in every reply prompt, so each distill (and the seed) writes a version row
-- here before overwriting agent_persona.voice_card. Buys rollback (re-upsert a
-- prior new_card) and drift inspection. Apply by hand in the Supabase SQL editor.
-- schema.sql mirrors this.
create table if not exists agent_persona_versions (
  id           bigserial primary key,
  agent_id     text not null,
  prior_card   text,                          -- card before this change; null on first seed
  new_card     text not null,                 -- card after this change
  from_upto    bigint not null,               -- watermark before the fold
  to_upto      bigint not null,               -- watermark after the fold (last folded msg id)
  sample_count int not null,                  -- real messages folded in this change
  created_at   timestamptz not null default now()
);

create index if not exists idx_persona_versions_agent
  on agent_persona_versions (agent_id, created_at desc);
