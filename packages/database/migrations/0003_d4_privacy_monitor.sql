-- D4: privacy threat monitor — monitors, checks, diffs, threat events,
-- alert rules, notifications. See docs/milestone-d4.md (D4-A through D4-F)
-- and architecture.md §62-§64.

-- ---------------------------------------------------------------------------
-- Privacy monitors: a registered user monitors one saved wallet. The wallet
-- identity lives in `wallets`; the bookmark in `saved_analyses`; the monitor
-- only references both. Status is deliberately a plain text column (repo
-- convention, no create type): ACTIVE | PAUSED | DEGRADED | ERROR | DISABLED.
-- ---------------------------------------------------------------------------
create table if not exists privacy_monitors (
  id bigserial primary key,
  user_id uuid not null references profiles (id) on delete cascade,
  wallet_id bigint not null references wallets (id) on delete cascade,
  saved_analysis_id bigint references saved_analyses (id) on delete set null,
  status text not null default 'ACTIVE',
  schedule_type text not null default 'DAILY',
  last_checked_at timestamptz,
  next_check_at timestamptz,
  last_analysis_id uuid references analysis_jobs (id) on delete set null,
  baseline_analysis_id uuid references analysis_jobs (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_monitors_user on privacy_monitors (user_id, created_at desc);
create unique index if not exists idx_monitors_user_wallet on privacy_monitors (user_id, wallet_id);
create index if not exists idx_monitors_due on privacy_monitors (next_check_at)
  where status = 'ACTIVE';
create index if not exists idx_monitors_wallet on privacy_monitors (wallet_id, status);

-- ---------------------------------------------------------------------------
-- Monitor checks: audit trail for every scheduled run (delay, reuse, errors).
-- Not user-owned directly; scoped through the owning monitor via RLS below.
-- ---------------------------------------------------------------------------
create table if not exists monitor_checks (
  id bigserial primary key,
  monitor_id bigint not null references privacy_monitors (id) on delete cascade,
  scheduled_for timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  status text not null default 'PENDING', -- PENDING|IN_PROGRESS|COMPLETED|REUSED|DELAYED|FAILED
  delay_ms bigint,
  analysis_id uuid references analysis_jobs (id) on delete set null,
  reused_analysis boolean not null default false,
  previous_analysis_id uuid references analysis_jobs (id) on delete set null,
  error_code text,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists idx_monitor_checks_monitor on monitor_checks (monitor_id, created_at desc);
create index if not exists idx_monitor_checks_status on monitor_checks (status, created_at);

-- ---------------------------------------------------------------------------
-- Exposure diffs: structured comparison between two analyses (D4-C). Unique
-- per comparison pair so duplicate fan-out messages cannot create dup rows.
-- ---------------------------------------------------------------------------
create table if not exists exposure_diffs (
  id bigserial primary key,
  monitor_id bigint not null references privacy_monitors (id) on delete cascade,
  previous_analysis_id uuid not null references analysis_jobs (id) on delete cascade,
  current_analysis_id uuid not null references analysis_jobs (id) on delete cascade,
  overall_change jsonb not null,
  dimension_changes jsonb not null default '[]',
  new_signals jsonb not null default '[]',
  removed_signals jsonb not null default '[]',
  changed_signals jsonb not null default '[]',
  entity_changes jsonb not null default '[]',
  relationship_changes jsonb not null default '[]',
  behavior_changes jsonb not null default '[]',
  attack_path_changes jsonb not null default '[]',
  data_quality_change jsonb not null default '{}',
  comparability jsonb not null default '{}',
  confidence numeric not null default 0,
  diff_version text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_diffs_pair on exposure_diffs (monitor_id, previous_analysis_id, current_analysis_id);
create index if not exists idx_diffs_monitor on exposure_diffs (monitor_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Threat events (D4-D): evidence-backed, fingerprint-deduplicated findings.
-- The fingerprint is the semantic identity of the event; the unique index on
-- (monitor_id, fingerprint) is the cooldown/dedup anchor. User-owned.
-- ---------------------------------------------------------------------------
create table if not exists threat_events (
  id bigserial primary key,
  monitor_id bigint not null references privacy_monitors (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  wallet_id bigint not null references wallets (id) on delete cascade,
  diff_id bigint references exposure_diffs (id) on delete set null,
  event_type text not null,
  severity text not null, -- INFO|LOW|MEDIUM|HIGH|CRITICAL
  confidence numeric not null,
  subject text not null,
  fingerprint text not null,
  title text not null,
  summary text not null,
  explanation text not null,
  evidence jsonb not null default '{}',
  state text not null default 'OPEN', -- OPEN|ACKNOWLEDGED|RESOLVED|EXPIRED
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  occurrence_count integer not null default 1,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_events_fingerprint on threat_events (monitor_id, fingerprint);
create index if not exists idx_events_user on threat_events (user_id, created_at desc);
create index if not exists idx_events_monitor on threat_events (monitor_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Monitor alert rules (D4-E): 1:1 with a monitor, created with safe defaults.
-- ---------------------------------------------------------------------------
create table if not exists monitor_alert_rules (
  id bigserial primary key,
  monitor_id bigint not null unique references privacy_monitors (id) on delete cascade,
  minimum_severity text not null default 'HIGH',
  minimum_confidence numeric not null default 0.60,
  overall_score_delta_threshold integer not null default 10,
  notify_new_entity boolean not null default true,
  notify_new_attack_path boolean not null default true,
  notify_behavior_change boolean not null default false,
  notify_data_quality_degraded boolean not null default true,
  cooldown_hours integer not null default 24,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Notifications (D4-F): delivery records with idempotency key + status guard.
-- User-owned; channel IN_APP | EMAIL. Never stores private labels beyond the
-- user's own inbox contents.
-- ---------------------------------------------------------------------------
create table if not exists notifications (
  id bigserial primary key,
  user_id uuid not null references profiles (id) on delete cascade,
  monitor_id bigint references privacy_monitors (id) on delete set null,
  event_id bigint references threat_events (id) on delete cascade,
  channel text not null default 'IN_APP',
  type text not null,
  title text not null,
  body text not null,
  severity text not null,
  read_at timestamptz,
  status text not null default 'PENDING', -- PENDING|SENT|FAILED|SUPPRESSED
  idempotency_key text not null,
  attempt_count integer not null default 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_notifications_key on notifications (idempotency_key);
create index if not exists idx_notifications_user on notifications (user_id, created_at desc);
create index if not exists idx_notifications_user_unread on notifications (user_id, read_at)
  where read_at is null;

-- ---------------------------------------------------------------------------
-- RLS on user-owned tables. The API uses the service role (bypasses RLS);
-- these policies scope direct client access, same pattern as saved_analyses.
-- Alert rules, checks and diffs are scoped through monitor ownership.
-- ---------------------------------------------------------------------------
alter table privacy_monitors enable row level security;
alter table monitor_alert_rules enable row level security;
alter table threat_events enable row level security;
alter table notifications enable row level security;
alter table monitor_checks enable row level security;
alter table exposure_diffs enable row level security;

create policy privacy_monitors_select_own on privacy_monitors
  for select using (user_id = auth.uid());
create policy privacy_monitors_insert_own on privacy_monitors
  for insert with check (user_id = auth.uid());
create policy privacy_monitors_update_own on privacy_monitors
  for update using (user_id = auth.uid());
create policy privacy_monitors_delete_own on privacy_monitors
  for delete using (user_id = auth.uid());

create policy threat_events_select_own on threat_events
  for select using (user_id = auth.uid());
create policy threat_events_insert_own on threat_events
  for insert with check (user_id = auth.uid());
create policy threat_events_update_own on threat_events
  for update using (user_id = auth.uid());
create policy threat_events_delete_own on threat_events
  for delete using (user_id = auth.uid());

create policy notifications_select_own on notifications
  for select using (user_id = auth.uid());
create policy notifications_insert_own on notifications
  for insert with check (user_id = auth.uid());
create policy notifications_update_own on notifications
  for update using (user_id = auth.uid());
create policy notifications_delete_own on notifications
  for delete using (user_id = auth.uid());

create policy monitor_alert_rules_select_own on monitor_alert_rules
  for select using (
    exists (select 1 from privacy_monitors pm where pm.id = monitor_alert_rules.monitor_id and pm.user_id = auth.uid())
  );
create policy monitor_alert_rules_insert_own on monitor_alert_rules
  for insert with check (
    exists (select 1 from privacy_monitors pm where pm.id = monitor_alert_rules.monitor_id and pm.user_id = auth.uid())
  );
create policy monitor_alert_rules_update_own on monitor_alert_rules
  for update using (
    exists (select 1 from privacy_monitors pm where pm.id = monitor_alert_rules.monitor_id and pm.user_id = auth.uid())
  );
create policy monitor_alert_rules_delete_own on monitor_alert_rules
  for delete using (
    exists (select 1 from privacy_monitors pm where pm.id = monitor_alert_rules.monitor_id and pm.user_id = auth.uid())
  );

create policy monitor_checks_select_own on monitor_checks
  for select using (
    exists (select 1 from privacy_monitors pm where pm.id = monitor_checks.monitor_id and pm.user_id = auth.uid())
  );

create policy exposure_diffs_select_own on exposure_diffs
  for select using (
    exists (select 1 from privacy_monitors pm where pm.id = exposure_diffs.monitor_id and pm.user_id = auth.uid())
  );
