-- Levyline schema. Plain SQL, applied in filename order by scripts/migrate.mjs.

create extension if not exists pgcrypto;

-- App-wide settings, including the development clock (see src/lib/clock.ts).
create table app_settings (
  key text primary key,
  value jsonb not null
);

create table clients (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table developments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  name text not null,
  created_at timestamptz not null default now(),
  unique (client_id, name)
);

create table units (
  id uuid primary key default gen_random_uuid(),
  development_id uuid not null references developments(id),
  unit_ref text not null,
  block text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (development_id, unit_ref)
);

-- One row per person. Staff-editable fields sit next to `imported`, a
-- snapshot of the values the last import wrote, so a re-import only
-- overwrites a field when the file itself changed it.
create table owners (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text,
  phone text,
  address text,
  do_not_contact boolean not null default false,
  do_not_contact_reason text,
  deceased boolean not null default false,
  deceased_note text,
  automation_paused boolean not null default false,
  automation_paused_reason text,
  imported jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- How an import recognises a person again: (normalised name, normalised
-- email), or (name, 'unit:<key>') when the row has no email. A confirmed
-- merge adds the other identity to the same owner.
create table owner_identities (
  name_key text not null,
  email_key text not null,
  owner_id uuid not null references owners(id) on delete cascade,
  primary key (name_key, email_key)
);

create table unit_owners (
  unit_id uuid not null references units(id),
  owner_id uuid not null references owners(id) on delete cascade,
  active boolean not null default true,
  sold_note text, -- "Owner sold unit ..." from the file: don't chase them for it
  ended_at timestamptz,
  primary key (unit_id, owner_id)
);

create table receivables (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  unit_id uuid not null references units(id),
  demand_ref text not null,
  kind text not null,
  period text,
  amount numeric(12, 2) not null,
  paid numeric(12, 2) not null default 0,
  due_date date not null,
  notes text,
  disputed boolean not null default false,
  dispute_reason text,
  imported jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, demand_ref)
);

create table imports (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  summary jsonb not null,
  skipped jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

-- Everything that happened to an owner, for their timeline.
create table events (
  id bigserial primary key,
  owner_id uuid references owners(id) on delete cascade,
  kind text not null,
  summary text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index events_owner_idx on events (owner_id, created_at desc);

-- Conversations. A thread is one email subject with one owner.
create table threads (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references owners(id) on delete cascade,
  subject text not null,
  created_at timestamptz not null default now()
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid references threads(id) on delete cascade,
  owner_id uuid references owners(id) on delete cascade, -- null: unmatched reply
  direction text not null check (direction in ('out', 'in')),
  source text not null default 'staff', -- staff | automation | commitment | owner
  to_address text,
  from_address text,
  reply_token text unique, -- outbound: the +token in our Reply-To
  subject text not null,
  body text not null,
  status text not null default 'queued', -- out: queued | sending | sent | failed; in: received
  attempts int not null default 0,
  last_error text,
  retryable boolean not null default true, -- after a failure: is another attempt worth making?
  provider_id text,
  provider_email_id text unique, -- inbound: Resend's email id (dedupes webhooks)
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index messages_owner_idx on messages (owner_id, created_at);

create table webhook_events (
  id text primary key, -- svix-id
  received_at timestamptz not null default now()
);

-- Commitments (rules 11 to 16).
create table commitments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references owners(id) on delete cascade,
  client_id uuid not null references clients(id),
  status text not null default 'active', -- active | broken | completed | cancelled
  note text,
  created_at timestamptz not null default now(),
  broken_at timestamptz
);
create unique index one_active_commitment_per_client
  on commitments (owner_id, client_id) where status = 'active';

create table commitment_receivables (
  commitment_id uuid not null references commitments(id) on delete cascade,
  receivable_id uuid not null references receivables(id),
  primary key (commitment_id, receivable_id)
);

create table instalments (
  id uuid primary key default gen_random_uuid(),
  commitment_id uuid not null references commitments(id) on delete cascade,
  seq int not null,
  due_date date not null,
  amount numeric(12, 2) not null check (amount > 0),
  paid_at timestamptz,
  unique (commitment_id, seq)
);

-- Automations (Part 3).
create table automations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  client_id uuid references clients(id),
  graph jsonb not null default '{"nodes":[],"edges":[]}'::jsonb,
  status text not null default 'draft', -- draft | live | paused
  live_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A graph as it was when it went live. Enrollments run against a version,
-- so editing a draft never moves an owner who is mid-way through.
create table automation_versions (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references automations(id) on delete cascade,
  graph jsonb not null,
  created_at timestamptz not null default now()
);

create table enrollments (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references automations(id) on delete cascade,
  version_id uuid not null references automation_versions(id),
  owner_id uuid not null references owners(id) on delete cascade,
  node_id text not null,
  state text not null default 'active', -- active | waiting | held | failed | completed | stopped
  wake_at timestamptz not null, -- virtual time (src/lib/clock.ts)
  hold_reason text,
  last_error text,
  started_at timestamptz not null, -- virtual time
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index one_running_enrollment
  on enrollments (automation_id, owner_id) where state not in ('completed', 'stopped');
create index enrollments_due_idx on enrollments (wake_at) where state in ('active', 'waiting', 'held');

-- One row per visit to a step. The unique key is what guarantees an owner is
-- never emailed twice for one step, even if the worker crashes and retries.
create table enrollment_steps (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references enrollments(id) on delete cascade,
  node_id text not null,
  kind text not null,
  status text not null, -- done | sending | failed
  detail text,
  message_id uuid references messages(id),
  created_at timestamptz not null default now(),
  unique (enrollment_id, node_id)
);

-- Rule 9: at most one automated email per owner per Irish calendar day.
create table automated_email_days (
  owner_id uuid not null references owners(id) on delete cascade,
  day date not null,
  step_id uuid not null references enrollment_steps(id) on delete cascade,
  primary key (owner_id, day)
);
