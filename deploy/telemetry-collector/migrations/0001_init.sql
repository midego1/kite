-- Kite telemetry collector. Days are UTC `YYYY-MM-DD` strings; no IP address, user agent or time of day is stored.

-- One row per UTC day and install: the heartbeat's fields, counts as ranges. Kept for 90 days, then rolled up into
-- `aggregates` and deleted (`rollUpOldDays` in src/index.ts).
CREATE TABLE daily (
	day TEXT NOT NULL,
	install_id TEXT NOT NULL,
	version TEXT NOT NULL,
	runtime TEXT NOT NULL,
	users_total TEXT NOT NULL,
	users_active_1d TEXT NOT NULL,
	users_active_7d TEXT NOT NULL,
	users_active_30d TEXT NOT NULL,
	mailboxes_total TEXT NOT NULL,
	mailboxes_active_1d TEXT NOT NULL,
	inbound_1d TEXT NOT NULL,
	outbound_1d TEXT NOT NULL,
	-- JSON array of module ids, such as ["calendar","drive"].
	modules_enabled TEXT NOT NULL,
	PRIMARY KEY (day, install_id)
);

CREATE INDEX daily_install_day_idx ON daily (install_id, day);

-- How many installs reported each value on a day, without install ids: `dimension` is `installs` (value ''),
-- `version`, `runtime`, `module` or a range field such as `users_total`.
CREATE TABLE aggregates (
	day TEXT NOT NULL,
	dimension TEXT NOT NULL,
	value TEXT NOT NULL,
	installs INTEGER NOT NULL,
	PRIMARY KEY (day, dimension, value)
);
