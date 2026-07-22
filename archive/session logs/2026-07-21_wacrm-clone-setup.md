# Session Log — wacrm clone + Supabase setup (2026-07-21)

**Outcome:** Cloned the `ArnasDon/wacrm` template (a separate, unrelated Next.js +
Supabase WhatsApp CRM — *not* the FourthspaceOS Stage-1 project this repo is), got it
installed, wired to the user's real Supabase project, migrated the full schema, and
running on localhost:3001. App boots and login/signup pages load against a live DB.
One open issue at end of session: browser-side "Failed to fetch" on signup (server-side
Supabase confirmed healthy; suspected stale client bundle — restart + hard-refresh
prescribed, not yet confirmed by user).

**What wacrm is:** self-hostable CRM template for WhatsApp — shared inbox, contacts,
sales pipelines, broadcasts, no-code automations. Next.js 16.2.6 (Turbopack) + Supabase
(Postgres/auth/storage) + Meta WhatsApp Cloud API. Node >=20. MIT. Entirely distinct
from the surrounding FourthspaceOS repo; just parked inside it as a nested folder.

## Steps

1. **Clone** — `git clone https://github.com/ArnasDon/wacrm.git`. Originally landed at
   `Claude Code/wacrm` (sibling of the main project).
2. **Install** — `npm install`, 690 packages, clean.
3. **Moved into this repo** at user request — now a **nested git repo** at
   `Whatsapp First layer/wacrm` (keeps its own `.git`; parent won't track its files).
4. **`.env.local`** created (NOT `.env` — Next.js convention; hidden dotfile, needs
   Explorer "Show hidden items"). Required keys explained to user:
   - `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` — DB address + public
     browser key.
   - `SUPABASE_SERVICE_ROLE_KEY` — admin key, server-side only.
   - `ENCRYPTION_KEY` — **auto-generated** 32-byte hex (AES-256-GCM for WhatsApp token
     encryption at rest). Done, real value.
   - `META_APP_SECRET` — still **placeholder**; only needed to connect a real WhatsApp
     number. Everything else in the CRM works without it.
   - `NEXT_PUBLIC_APP_LOCALE=en`.
   User filled in the three real Supabase keys themselves.

## Supabase provisioning

- **CLI already installed** — v2.107.0, and **already logged in** (`supabase projects
  list` worked without auth).
- User's projects visible: `ARAI_Marking` (inactive) and **`Whatsapp_Automation`**
  (`aymtpqpqwqfpbsbreniy`, ACTIVE_HEALTHY, ap-southeast-1) — the latter matches the URL
  in `.env.local`.
- `supabase link --project-ref aymtpqpqwqfpbsbreniy` — linked with no password prompt
  (used the existing login token). Note: repo has **no `supabase/config.toml`**; link
  still worked.

**Migration blocker (fixed) — `uuid_generate_v4() does not exist`.** `supabase db push`
failed on the very first file (`001_initial_schema.sql`). Root cause: modern Supabase
installs the `uuid-ossp` extension into the **`extensions`** schema, which is NOT on the
migration search_path, so the unqualified `uuid_generate_v4()` calls throughout 001+
couldn't resolve. **Fix (root cause, one file, not 36 edits):** added
`supabase/migrations/000_uuid_ossp_public.sql` that does
`DROP EXTENSION IF EXISTS "uuid-ossp"; CREATE EXTENSION "uuid-ossp" WITH SCHEMA public;`
so all later files find the function. (Chose drop+recreate over plain `WITH SCHEMA
public` because the latter won't relocate an already-existing extension.)

**Migration push (succeeded).** All 36 migrations (000 + 001–036) applied —
"Finished supabase db push." The many `NOTICE ... does not exist, skipping` lines are
harmless: the files use idempotent `DROP POLICY/TRIGGER IF EXISTS` guards on a fresh DB.
Full CRM schema now live: profiles, contacts, conversations, pipelines, broadcasts,
automations, api_keys, notifications, webhook_endpoints, ai_reply/knowledge, flows,
interactive messages, account sharing/invitations, etc.

## Run

- `npx next dev -p 3001` (repo `dev` script sets no port; `-p 3001` passed explicitly).
- Confirmed UP: `/` → 307 (locale/login redirect), `/login` and `/signup` → 200.
- After user swapped in real keys, **restarted with `.next` cache cleared** — because
  `NEXT_PUBLIC_*` are inlined into the client bundle at compile time, so a server that
  was running under the old placeholder values would still ship `placeholder.supabase.co`
  to the browser.

**Gotchas worth remembering:**
- Killing the dev server on Windows: `Get-NetTCPConnection -LocalPort 3001 -State Listen
  | Stop-Process -Id $_.OwningProcess -Force` (Git-Bash PIDs don't map to Windows PIDs).
- **`supabase db push` is blocked by the Claude Code auto-mode classifier** (writes to a
  live remote DB) — needs explicit user permission before it runs. Do not try to route
  around the block.
- Bash mangles complex inline PowerShell (`$_`, `Where-Object` blocks) — use the
  PowerShell tool directly for those.

## Open issue (unresolved at session end)

**Signup shows "Failed to fetch" in the browser.** Server-side diagnosis done:
`GET /auth/v1/health` → 200, `/auth/v1/settings` shows `email:true`,
`disable_signup:false`, **`mailer_autoconfirm:false`** (email confirmation ON by
default). So Supabase is reachable and signup is enabled server-side; the fetch failure
is client-side. Most likely a stale client bundle from before the key swap. Prescribed:
server already restarted with cleared cache → user to **hard-refresh (Ctrl+Shift+R)**
and retry; if it persists, read the failing request in DevTools → Network (is it still
hitting `placeholder`? CORS? which URL?). **Also flagged:** because
`mailer_autoconfirm:false`, a successful signup will demand email confirmation — offer
to disable it via CLI for local dev if no email arrives.

## Still placeholder / not done
- `META_APP_SECRET` — only for connecting a real WhatsApp number.
- No user account created yet (signup is the blocker above).
- CLI update available (v2.109.1) — cosmetic, ignored.
