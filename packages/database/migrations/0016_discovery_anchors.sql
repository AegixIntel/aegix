-- Discovery ID chain anchors.
-- See docs/milestone-d14-rewind-discovery.md §5.
--
-- Additive. The hash chain on `discoveries` is tamper-evident only against
-- someone who cannot rewrite the database. An anchor is the receipt a public
-- OpenTimestamps calendar returned for one chain hash: the calendar commits
-- that hash to the Bitcoin chain, so the time at which the chain had reached
-- that discovery can be checked without trusting AEGIX.
--
-- A chain hash commits to every discovery before it, so one anchor on the
-- head covers the whole chain up to that row.

create table discovery_anchors (
  id bigserial primary key,
  discovery_id bigint not null references discoveries (id),
  chain_hash text not null,
  calendar_url text not null,
  -- The calendar's answer, byte for byte: the operations that lead from the
  -- chain hash to the calendar's pending attestation.
  receipt bytea not null,
  submitted_at timestamptz not null default now(),
  unique (chain_hash, calendar_url)
);
create index idx_discovery_anchors_discovery on discovery_anchors (discovery_id, id);

create or replace function aegix_stamp_anchor_submitted_at() returns trigger
  language plpgsql as $$
begin
  new.submitted_at := now();
  return new;
end $$;

create trigger discovery_anchors_stamp before insert on discovery_anchors
  for each row execute function aegix_stamp_anchor_submitted_at();
create trigger discovery_anchors_immutable before update or delete on discovery_anchors
  for each row execute function aegix_reject_mutation();
