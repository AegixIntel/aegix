-- D14: observation ledger, Rewind captures and the Discovery Engine.
-- See docs/milestone-d14-rewind-discovery.md.
--
-- Additive. Existing wallet/analysis tables are untouched. Every table here is
-- append-only and that is enforced by the database, not by convention: Rewind
-- is only valid if a stored capture can never be rewritten, and a Discovery ID
-- is only evidence if its timestamp cannot be edited afterwards.

-- ---------------------------------------------------------------------------
-- Enforcement. UPDATE and DELETE are rejected on every D14 table, and the
-- "when did AEGIX know this" column is stamped by the database clock so a
-- writer cannot backdate a row.
-- ---------------------------------------------------------------------------
create or replace function aegix_reject_mutation() returns trigger
  language plpgsql as $$
begin
  raise exception '% is append-only: % is not permitted', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end $$;

create or replace function aegix_stamp_observed_at() returns trigger
  language plpgsql as $$
begin
  new.observed_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Observation ledger: one value of one series at one event time. Bitemporal:
-- event_time is when the value applies, observed_at is when AEGIX first held
-- it. The first observation of (series, event_time, source) wins; a provider
-- revising history later does not change what was known at the time.
-- ---------------------------------------------------------------------------
create table observation_points (
  id bigserial primary key,
  series_key text not null check (length(series_key) > 0),
  event_time timestamptz not null,
  value numeric not null,
  source text not null check (length(source) > 0),
  observed_at timestamptz not null default now(),
  unique (series_key, event_time, source)
);
create index idx_observation_points_series_time on observation_points (series_key, event_time);

create trigger observation_points_stamp before insert on observation_points
  for each row execute function aegix_stamp_observed_at();
create trigger observation_points_immutable before update or delete on observation_points
  for each row execute function aegix_reject_mutation();

-- ---------------------------------------------------------------------------
-- Signal captures: one run of a signal engine over one subject. A capture
-- that found no signal is still recorded — without it, "nothing was visible"
-- and "nobody was looking" are indistinguishable in a replay.
-- ---------------------------------------------------------------------------
create table signal_captures (
  id bigserial primary key,
  domain text not null check (domain in ('MARKET')),
  subject text not null,
  bucket_start timestamptz not null,
  engine_version text not null,
  provider text not null,
  provider_status text not null,
  quality_grade text not null,
  signal_count integer not null check (signal_count >= 0),
  observed_at timestamptz not null default now(),
  unique (domain, subject, bucket_start, engine_version)
);
create index idx_signal_captures_subject_time on signal_captures (domain, subject, observed_at);

create trigger signal_captures_stamp before insert on signal_captures
  for each row execute function aegix_stamp_observed_at();
create trigger signal_captures_immutable before update or delete on signal_captures
  for each row execute function aegix_reject_mutation();

create table signal_snapshots (
  id bigserial primary key,
  capture_id bigint not null references signal_captures (id),
  signal_type text not null,
  severity integer not null,
  confidence numeric not null,
  title text not null,
  summary text not null,
  evidence jsonb not null default '[]',
  engine_version text not null,
  unique (capture_id, signal_type)
);

create trigger signal_snapshots_immutable before update or delete on signal_snapshots
  for each row execute function aegix_reject_mutation();

-- ---------------------------------------------------------------------------
-- Discovery runs: one scan over one epoch. The run records how many
-- hypotheses were tested, because a q-value means nothing without its m.
-- ---------------------------------------------------------------------------
create table discovery_runs (
  id bigserial primary key,
  engine_version text not null,
  epoch_end timestamptz not null,
  window_hours integer not null,
  baseline_hours integer not null,
  fdr_level numeric not null,
  method text not null,
  series_count integer not null,
  hypotheses_considered integer not null,
  hypotheses_tested integer not null,
  rejections integer not null,
  completed_at timestamptz not null default now(),
  unique (engine_version, epoch_end)
);

create trigger discovery_runs_immutable before update or delete on discovery_runs
  for each row execute function aegix_reject_mutation();

-- Every hypothesis the run considered, including the ones that found nothing
-- and the ones that were not eligible. The losers are the evidence for m.
create table discovery_tests (
  id bigserial primary key,
  run_id bigint not null references discovery_runs (id),
  pair_key text not null,
  series_a text not null,
  series_b text not null,
  lag_hours integer not null,
  status text not null check (status in (
    'TESTED', 'INSUFFICIENT_DATA', 'NO_VARIANCE', 'INSUFFICIENT_BASELINE', 'KNOWN_RELATIONSHIP', 'AWAITING_CONFIRMATION_WINDOW'
  )),
  role text check (role in ('NOVELTY', 'CONFIRMATION')),
  r numeric,
  r_baseline numeric,
  n integer not null default 0,
  n_effective numeric,
  p_value numeric,
  q_value numeric,
  rejected boolean not null default false,
  unique (run_id, pair_key, lag_hours)
);

create trigger discovery_tests_immutable before update or delete on discovery_tests
  for each row execute function aegix_reject_mutation();

-- ---------------------------------------------------------------------------
-- Discoveries. detected_at and the hash chain are written by the trigger
-- below, never by the application: each row commits to the row before it, so
-- removing or reordering a discovery breaks every later chain_hash.
-- ---------------------------------------------------------------------------
create table discoveries (
  id bigserial primary key,
  pair_key text not null,
  series_a text not null,
  series_b text not null,
  lag_hours integer not null,
  direction text not null check (direction in ('POSITIVE', 'NEGATIVE')),
  window_end timestamptz not null,
  engine_version text not null,
  run_id bigint not null references discovery_runs (id),
  fingerprint text not null unique,
  card jsonb not null,
  detected_at timestamptz not null default now(),
  prev_chain_hash text,
  chain_hash text not null unique,
  unique (pair_key, engine_version)
);

create or replace function aegix_chain_discovery() returns trigger
  language plpgsql as $$
declare
  previous text;
begin
  -- Serialize inserts so two concurrent discoveries cannot share a parent.
  perform pg_advisory_xact_lock(hashtext('aegix:discovery-chain'));
  select chain_hash into previous from discoveries order by id desc limit 1;
  new.detected_at := clock_timestamp();
  new.prev_chain_hash := previous;
  new.chain_hash := encode(sha256(convert_to(
    coalesce(previous, '') || '|' || new.fingerprint || '|' ||
    to_char(new.detected_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'UTF8')), 'hex');
  return new;
end $$;

create trigger discoveries_chain before insert on discoveries
  for each row execute function aegix_chain_discovery();
create trigger discoveries_immutable before update or delete on discoveries
  for each row execute function aegix_reject_mutation();

-- A discovery's status is the latest event, never an edited column.
create table discovery_events (
  id bigserial primary key,
  discovery_id bigint not null references discoveries (id),
  run_id bigint not null references discovery_runs (id),
  event_type text not null check (event_type in ('CANDIDATE', 'CONFIRMED', 'NOT_CONFIRMED')),
  detail jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (discovery_id, run_id)
);
create index idx_discovery_events_discovery on discovery_events (discovery_id, id);

create trigger discovery_events_immutable before update or delete on discovery_events
  for each row execute function aegix_reject_mutation();
