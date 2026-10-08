-- D14: signal captures for news topics and for sector and commodity funds.
-- See docs/milestone-d14-rewind-discovery.md §3a.
--
-- Additive. signal_captures already holds one capture per subject per time
-- bucket and is append-only; this only lets a capture belong to two more
-- domains. No existing row changes, and the append-only triggers stay.

alter table signal_captures drop constraint signal_captures_domain_check;
alter table signal_captures add constraint signal_captures_domain_check
  check (domain in ('MARKET', 'NARRATIVE', 'SECTOR'));

-- A replay of an asset reads every capture of a domain in a window.
create index idx_signal_captures_domain_time on signal_captures (domain, observed_at) where signal_count > 0;
