-- WhatsApp addresses some contacts by an opaque "<id>@lid" (privacy linked-id)
-- instead of "<phone>@s.whatsapp.net". Inbound @lid messages carry both the lid
-- and the real phone (key.senderPn); OUTBOUND @lid messages carry only the lid,
-- no phone. Since leads key on phone, outbound-to-@lid messages had nothing to
-- key on and were dropped. We learn the lid↔phone link from inbound and store it
-- here, so outbound can look the lead up by lid. Nullable: null = classic phone
-- contact, or a @lid lead we haven't linked yet. Apply by hand in the Supabase
-- SQL editor. schema.sql mirrors this for fresh projects.
alter table leads add column if not exists lid text;

-- Partial unique index (like idx_messages_wa_id): only non-null lids collide, so
-- classic-phone leads (lid null) are unaffected, two contacts can't share a lid,
-- and findLeadByLid gets an index.
create unique index if not exists idx_leads_lid on leads (agent_id, lid) where lid is not null;
