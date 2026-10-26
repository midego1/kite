-- Kite telemetry collector. Days are UTC `YYYY-MM-DD` strings; no IP address, user agent or time of day is stored.
CREATE TABLE installs (
	install_id TEXT PRIMARY KEY NOT NULL,
	first_seen TEXT NOT NULL,
	last_seen TEXT NOT NULL,
	last_version TEXT NOT NULL,
	last_runtime TEXT NOT NULL
);

CREATE TABLE daily (
	day TEXT NOT NULL,
	install_id TEXT NOT NULL,
	version TEXT NOT NULL,
	runtime TEXT NOT NULL,
	users_total INTEGER NOT NULL,
	users_active_1d INTEGER NOT NULL,
	users_active_7d INTEGER NOT NULL,
	users_active_30d INTEGER NOT NULL,
	mailboxes_total INTEGER NOT NULL,
	mailboxes_active_1d INTEGER NOT NULL,
	inbound_1d INTEGER NOT NULL,
	outbound_1d INTEGER NOT NULL,
	-- JSON array of module ids, such as ["calendar","drive"].
	modules_enabled TEXT NOT NULL,
	PRIMARY KEY (day, install_id)
);

CREATE INDEX daily_install_day_idx ON daily (install_id, day);
