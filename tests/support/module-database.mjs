import { cpSync } from "node:fs";
import { basename, join } from "node:path";
import { root } from "./modules-bundle.mjs";

export const migrationsDir = join(root, "drizzle/migrations");

/** A copy of the migrations numbered below `limit`, which stands in for a database from before that migration. */
export function copyMigrationsBefore(directory, limit) {
	const target = join(directory, `migrations-before-${limit}`);
	cpSync(migrationsDir, target, {
		recursive: true,
		filter: (source) => {
			const number = basename(source).match(/^(\d+)_.*\.sql$/)?.[1];
			return number === undefined || Number(number) < limit;
		},
	});
	return target;
}

/** Two users, a mailbox with a message and a template, two calendar events and one booking event type. */
export function seedAccountData(db) {
	db.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES
			('owner', 'owner@example.com', 'hash', 'Owner', 1),
			('member', 'member@example.com', 'hash', 'Member', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-a', 'owner', 'domain-1', 'a', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, thread_id, created_at) VALUES
			('message-1', 'owner', 'mailbox-a', 'inbound', 'customer@example.net', 'a@example.com', 'Question', 'Hello', 'received', 'thread-1', 2),
			('template-1', 'owner', 'mailbox-a', 'outbound', 'a@example.com', '', 'Welcome', 'Hi there', 'template', 'thread-2', 3);
		INSERT INTO calendar_events (id, user_id, title, description, location, attendees, starts_at, ends_at, created_at, updated_at) VALUES
			('event-1', 'owner', 'Café review', 'Quarterly numbers', 'Room 4', '["ana@example.com"]', 100, 200, 4, 4),
			('event-2', 'member', 'Booked call', '', 'Video', '[]', 300, 400, 5, 5);
		INSERT INTO booking_events (id, user_id, name, slug, duration_minutes, created_at, updated_at) VALUES ('type-1', 'member', 'Intro', 'intro', 30, 6, 6);
	`);
}

export function seedBookingAppointment(db) {
	db.db.exec(
		"INSERT INTO booking_appointments (calendar_event_id, booking_event_id, created_at) VALUES ('event-2', 'type-1', 7)",
	);
}

/** Templates off, Member C restricted from Calendar, and a booked appointment. */
export function seedModuleState(db) {
	db.db.exec(`
		UPDATE module_settings SET enabled = 0, updated_at = 9, updated_by = 'owner' WHERE module_id = 'templates';
		INSERT INTO user_module_access (id, user_id, module_id, allowed, updated_at, updated_by) VALUES ('access-1', 'member', 'calendar', 0, 9, 'owner');
	`);
	seedBookingAppointment(db);
}
