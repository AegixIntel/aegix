-- Loads the CSV written by scripts/backfill-discovery-history.ts into the
-- observation ledger. Run with psql, with the CSV at /tmp/backfill.csv.
--
-- The ledger is append-only, so this cannot be undone. It refuses to load
-- anything if a backfilled hour would touch a series' first live observation.
\set ON_ERROR_STOP 1
begin;
create temp table b (series_key text, event_time timestamptz, value numeric, source text) on commit drop;
\copy b from /tmp/backfill.csv csv
select 'staged', count(*), count(distinct series_key), min(event_time), max(event_time) from b;

do $$
declare violations integer;
begin
  select count(*) into violations from b join (
    select series_key, min(event_time) as first_live from observation_points
    where source not in ('coingecko', 'geckoterminal:raydium-clmm') group by 1
  ) l using (series_key)
  where b.event_time >= date_trunc('hour', l.first_live) - interval '1 hour';
  if violations > 0 then raise exception '% backfilled rows reach a live observation', violations; end if;
end $$;

with ins as (
  insert into observation_points (series_key, event_time, value, source)
  select series_key, event_time, value, source from b
  on conflict (series_key, event_time, source) do nothing
  returning 1
) select 'inserted', count(*) from ins;
commit;

select source, count(*), count(distinct series_key), min(event_time), max(event_time), min(observed_at), max(observed_at)
from observation_points group by 1 order by 1;
