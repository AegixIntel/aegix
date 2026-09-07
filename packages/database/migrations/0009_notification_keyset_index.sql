-- Stable, user-scoped keyset pagination for the public-beta in-app inbox.
-- Existing notification rows and dormant email compatibility fields remain.
create index if not exists idx_notifications_in_app_keyset
  on notifications (user_id, created_at desc, id desc)
  where channel = 'IN_APP';
