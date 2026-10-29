-- Message volume is no longer collected. Kite installs stop sending `inbound_1d` and `outbound_1d`; the collector
-- accepts them from older installs and ignores them (src/validate.ts). This stops storing them and erases what was
-- stored: the columns, their per-day totals and the public summary built from them.
ALTER TABLE daily DROP COLUMN inbound_1d;
ALTER TABLE daily DROP COLUMN outbound_1d;
DELETE FROM aggregates WHERE dimension IN ('inbound_1d', 'outbound_1d');
-- Recomputed by the next daily cron, or on the first public request; until then no stale ranges are served.
DELETE FROM summary_cache;
