-- The public GET /v1/summary as stored JSON (one row), refreshed by the daily cron, so public requests read one row.
-- It holds only totals with small counts shown as "<5", never an install id.
CREATE TABLE summary_cache (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	body TEXT NOT NULL
);
