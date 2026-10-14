import type { ModuleId, RecordKind, RecordRef } from "@/lib/modules/module-types";

const MAX_REF_ID_CHARS = 160;

function moduleRef(value: unknown, moduleId: ModuleId): RecordRef | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const { kind, id } = value as Record<string, unknown>;
	// A module names only its own records; anything else would let it point Activity at another module's data.
	if (typeof kind !== "string" || !kind.startsWith(`${moduleId}:`) || kind.length === moduleId.length + 1) return null;
	if (typeof id !== "string" || !id || id.length > MAX_REF_ID_CHARS) return null;
	return { kind: kind as RecordKind, id };
}

/**
 * The record a module action created, changed or removed: the `ref` its result carried (stored in the
 * row's `after`). Calendar rows written before actions returned refs carry only `eventId`.
 */
export function moduleActionRef(row: { after: Record<string, unknown> | null }, moduleId: ModuleId): RecordRef | null {
	const ref = moduleRef(row.after?.ref, moduleId);
	if (ref) return ref;
	const eventId = row.after?.eventId;
	return moduleId === "calendar" && typeof eventId === "string" && eventId
		? { kind: "calendar:event", id: eventId }
		: null;
}
