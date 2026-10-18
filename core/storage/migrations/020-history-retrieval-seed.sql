-- History backfills use the same initial retrieval priority as native lite capture.
-- This repairs early DSH builds that persisted vectors but seeded priority at zero.
UPDATE traces SET priority = 0.5
WHERE priority = 0
  AND id GLOB 'tr_history_*'
  AND tags_json LIKE '%"history_backfill"%';
