-- FourthspaceOS Stage-1 storage. Mirrors the proven SQLite shape (see the
-- archived src/store.ts) in Postgres. Every row carries agent_id so the
-- one-agent demo is already multi-tenant-shaped. Wipe & recreate: run this on a
-- clean Supabase project (CLAUDE.md: the old junk project is being wiped).

drop table if exists memory cascade;
drop table if exists messages cascade;
drop table if exists leads cascade;

create table leads (
  id            bigserial primary key,
  agent_id      text not null,
  phone         text not null,
  name          text,
  stage         text not null default 'first_contact',
  -- Approval gate (Dennis/Mitko problem): the read-pipe sees EVERY 1:1 chat, but
  -- only agent-approved numbers should be treated as leads. A new number lands
  -- 'pending' and is dropped (no cards) until the agent taps Yes/No on the prompt.
  monitor       text not null default 'pending',  -- 'pending' | 'approved' | 'rejected'
  budget        text,
  area          text,
  requirement   text,
  status        text not null default 'open',
  next_question text,
  replies_json  text,
  summary       text,
  summary_upto  bigint not null default 0,  -- id of the last message folded into summary (watermark)
  updated_at    timestamptz not null default now(),
  unique (agent_id, phone)
);

create table messages (
  id        bigserial primary key,
  agent_id  text not null,
  lead_id   bigint not null references leads(id),
  direction text not null,                 -- 'in' | 'out'
  body      text not null,
  wa_id     text,                          -- provider message id for dedup; null for outbound/simulated
  ts        timestamptz not null default now()
);

-- Partial unique index: only non-null wa_ids collide, so outbound/simulated rows
-- (wa_id null) are unaffected. Powers saveMessage's on-conflict-do-nothing dedup.
create unique index idx_messages_wa_id on messages (agent_id, wa_id) where wa_id is not null;

-- Durable per-lead facts. Rewritten wholesale each time memory is regenerated.
create table memory (
  id       bigserial primary key,
  agent_id text not null,
  lead_id  bigint not null references leads(id),
  fact     text not null
);
