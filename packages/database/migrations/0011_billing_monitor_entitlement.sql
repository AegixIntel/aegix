-- D11 revenue safety: distinguish monitors paused by a plan limit from
-- monitors a user paused on purpose.
--
-- When a manually provisioned subscription ends unpaid the identity drops to
-- the free plan. Its monitors beyond the free level are paused rather than
-- deleted, and an operator confirming payment must be able to restore exactly
-- those — never one the user paused themselves, and never a disabled or
-- errored one. A single nullable reason column carries that distinction; no
-- status value is added, so D4's MonitorStatus vocabulary is unchanged.
--
-- Additive and inert: every existing monitor keeps status_reason = null.

alter table privacy_monitors add column if not exists status_reason text;

-- The worker reconciles a user's monitors after every billing transition.
-- This partial index keeps the "which monitors did billing pause" lookup off
-- a sequential scan without indexing the common status_reason = null rows.
create index if not exists idx_monitors_entitlement_paused
  on privacy_monitors (user_id, created_at)
  where status = 'PAUSED' and status_reason = 'ENTITLEMENT_PAUSED';
