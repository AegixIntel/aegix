-- Loads the CSV written by scripts/backfill-narrative-history.ts into the
-- observation ledger. Run with psql, with the CSV at /tmp/narrative-history.csv.
--
-- The ledger is append-only, so this cannot be undone. An hour the ledger
-- already holds keeps its first observation; the overlap line compares them.
\set ON_ERROR_STOP 1
begin;
create temp table b (series_key text, event_time timestamptz, value numeric, source text) on commit drop;
\copy b from /tmp/narrative-history.csv csv
select 'overlap', count(*), round(avg(abs(b.value - o.value))::numeric, 6), round(max(abs(b.value - o.value))::numeric, 6), round(avg(o.value)::numeric, 4)
from b join observation_points o using (series_key, event_time, source);
with ins as (
  insert into observation_points (series_key, event_time, value, source)
  select series_key, event_time, value, source from b where source = 'gdelt-doc-v2' and series_key like 'narrative:%'
  on conflict (series_key, event_time, source) do nothing returning 1
) select 'inserted', count(*) from ins;
commit;
select replace(replace(series_key,'narrative:',''),':news_volume_share',''), count(*), min(event_time), max(event_time) from observation_points where source = 'gdelt-doc-v2' group by 1 order by 1;
