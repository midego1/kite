import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { bookingEvents, calendarEvents, users } from "./index";

/** Install-wide module switch. A missing row means the manifest's `defaultEnabled`. */
export const moduleSettings = sqliteTable(
	"module_settings",
	{
		id: text("id").primaryKey(),
		moduleId: text("module_id").notNull(),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
	},
	(t) => [uniqueIndex("module_settings_module_id_unique").on(t.moduleId)],
);

/** Per-user restriction. A missing row means allowed. */
export const userModuleAccess = sqliteTable(
	"user_module_access",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		moduleId: text("module_id").notNull(),
		allowed: integer("allowed", { mode: "boolean" }).notNull().default(true),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
	},
	(t) => [uniqueIndex("user_module_access_user_module_unique").on(t.userId, t.moduleId)],
);

/** Links a calendar event created by a public booking to the event type that was booked. */
export const bookingAppointments = sqliteTable(
	"booking_appointments",
	{
		calendarEventId: text("calendar_event_id")
			.primaryKey()
			.references(() => calendarEvents.id, { onDelete: "cascade" }),
		bookingEventId: text("booking_event_id").references(() => bookingEvents.id, { onDelete: "set null" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [index("booking_appointments_booking_event_idx").on(t.bookingEventId)],
);
