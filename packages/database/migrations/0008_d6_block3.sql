-- D6 Block 3: correlation-alert email delivery (D6-I1), notification email
-- destinations for wallet-only accounts (D6-I1 §7-§8), and webhook retry
-- audit fixes (D6-J). See docs/milestone-d6.md (D6-I1, D6-J).

-- ---------------------------------------------------------------------------
-- D6-I1 fix (real bug found in audit): notifications.event_id was declared as
-- a foreign key to threat_events(id), but the D6-F correlation pipeline
-- persists correlation events into correlation_threat_events and references
-- those ids from notifications.event_id. Every correlation IN_APP/EMAIL
-- notification insert therefore failed with a FK violation in the real
-- pipeline (the Block 2 E2E exercised repos directly, never the full
-- pipeline). The column stays a loose bigint reference (same polymorphic
-- pattern as notifications.monitor_id): it may point at threat_events OR
-- correlation_threat_events. Historical rows are untouched.
-- ---------------------------------------------------------------------------
alter table notifications drop constraint if exists notifications_event_id_fkey;

-- ---------------------------------------------------------------------------
-- D6-I1 §7-§8: wallet-only auth means authentication identity and the email
-- notification destination are SEPARATE concepts. Email is a notification
-- destination only — it never becomes a login identity. Delivery is only
-- allowed to a VERIFIED destination (verified_at set by the code-verification
-- flow in the API). Unverified addresses are never emailed in production.
-- ---------------------------------------------------------------------------
alter table profiles add column if not exists notification_email text;
alter table profiles add column if not exists notification_email_verified_at timestamptz;
alter table profiles add column if not exists email_verification_code_hash text;
alter table profiles add column if not exists email_verification_code_expires_at timestamptz;
alter table profiles add column if not exists email_verification_attempts integer not null default 0;
