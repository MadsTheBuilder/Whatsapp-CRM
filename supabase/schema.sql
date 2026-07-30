-- FourthspaceOS Stage-1 storage. Mirrors the proven SQLite shape (see the
-- archived src/store.ts) in Postgres. Every row carries agent_id so the
-- one-agent demo is already multi-tenant-shaped. Wipe & recreate: run this on a
-- clean Supabase project (CLAUDE.md: the old junk project is being wiped).

drop table if exists agent_persona_versions cascade;
drop table if exists agent_persona cascade;
drop table if exists memory cascade;
drop table if exists messages cascade;
drop table if exists leads cascade;
drop table if exists agents cascade;

-- Agent registry: the receiving number selects the lane. The whole multi-agent
-- fix hinges on this — every inbound message resolves its agent from the number
-- it arrived on (read_number), and every bot message routes back to that agent's
-- send_number. read_number is the display_phone_number on a dialog360 webhook, or
-- the dev's own E.164 on the baileys pipe; send_number is where suggestions,
-- reminders and Q&A answers land. Often equal (bot reads and sends to one phone).
-- Registry is the ONLY source of identity — no env fallback; an unregistered
-- number is dropped. Numbers are E.164 digits, no '+' (matches Meta/360dialog).
create table agents (
  agent_id      text primary key,
  read_number   text not null unique,
  send_number   text not null,
  name          text,
  -- Goyzer's sender number (bare digits). Only a card FROM this number triggers the
  -- portal lead-relay; null = this agent runs no relay. See src/portal/goyzer.ts.
  goyzer_number text,
  created_at    timestamptz not null default now()
);

create table leads (
  id            bigserial primary key,
  agent_id      text not null,
  phone         text not null,
  -- Opaque WhatsApp "<id>@lid" (privacy linked-id) for this contact, learned from
  -- an inbound message (which carries both lid + phone). Lets an outbound @lid
  -- message — which carries only the lid, no phone — resolve back to this lead.
  lid           text,
  name          text,
  stage         text not null default 'first_contact',
  -- Approval gate (Dennis/Mitko problem): the read-pipe sees EVERY 1:1 chat, but
  -- only agent-approved numbers should be treated as leads. A new number lands
  -- 'pending' and is dropped (no cards) until the agent taps Yes/No on the prompt.
  monitor       text not null default 'pending',  -- 'pending' | 'approved' | 'rejected'
  -- Sales funnel stage, separate from `stage` (conversation-depth, drives tone).
  -- new | no_reply | qualifies | details_sent | meeting_done | eoi | deal_closed | waste
  pipeline      text not null default 'new'
                check (pipeline in ('new','no_reply','qualifies','details_sent','meeting_done','eoi','deal_closed','waste')),
  budget        text,
  area          text,
  requirement   text,
  deal_type     text,  -- rent | buy
  unit_type     text,  -- apartment | townhouse | villa | ...
  beds          text,  -- studio | 1BR | 2BR | ...
  timeline      text,  -- move-in / buy timing the lead stated ("November", "lease ends Oct")
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

-- Look up a lead by its opaque @lid (for outbound @lid messages that carry no
-- phone). Partial: only non-null lids collide, so classic-phone leads are free.
create unique index idx_leads_lid on leads (agent_id, lid) where lid is not null;

-- Durable per-lead facts. Rewritten wholesale each time memory is regenerated.
create table memory (
  id       bigserial primary key,
  agent_id text not null,
  lead_id  bigint not null references leads(id),
  fact     text not null
);

-- Layer 2: per-agent voice card. Seeded by the voice-extraction role-play skill,
-- later folded on top by a distill job (not built yet). One markdown blob prepended
-- to every reply prompt so the model mirrors THIS agent's voice. null = generic
-- fallback (cold start, zero regression). card_upto mirrors leads.summary_upto.
create table agent_persona (
  agent_id   text primary key,
  voice_card text,                          -- markdown blob; null = generic fallback
  card_upto  bigint not null default 0,     -- watermark: id of last outbound msg folded into the card
  interview_state jsonb,                     -- in-flight WhatsApp voice interview; null = none (migration 008)
  updated_at timestamptz not null default now()
);

-- Layer 2B: audit log for voice-card changes. Each distill (and the seed) writes a
-- row here before overwriting agent_persona.voice_card, for rollback + drift audit.
create table agent_persona_versions (
  id           bigserial primary key,
  agent_id     text not null,
  prior_card   text,                          -- card before this change; null on first seed
  new_card     text not null,
  from_upto    bigint not null,
  to_upto      bigint not null,
  sample_count int not null,
  created_at   timestamptz not null default now()
);
create index idx_persona_versions_agent on agent_persona_versions (agent_id, created_at desc);
