-- D15: signal captures for the anomaly detector.
-- See docs/milestone-d15-market-intelligence-engines.md §2.
--
-- Additive, like 0017: a capture may belong to one more domain. An anomaly
-- capture's subject is a ledger series key and its bucket is the hour the
-- measured change ends in. No existing row changes, and the append-only
-- triggers stay.

alter table signal_captures drop constraint signal_captures_domain_check;
alter table signal_captures add constraint signal_captures_domain_check
  check (domain in ('MARKET', 'NARRATIVE', 'SECTOR', 'ANOMALY'));
