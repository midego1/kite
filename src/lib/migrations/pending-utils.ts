import { isAdmin, isPrimaryAdmin } from "@/lib/auth/admin";
import type { SessionUser } from "@/lib/auth/types";

/**
 * What the pending-migrations status tells a user beyond the count: the migration names go only to the primary
 * admin, who can apply them; the primary admin's name and address only to the other admins, so they know whom to
 * ask. A member gets neither.
 */
export function pendingStatusOptions(user: Pick<SessionUser, "role" | "isPrimaryAdmin">): {
	includeNames: boolean;
	includeApplier: boolean;
} {
	const primary = isPrimaryAdmin(user);
	return { includeNames: primary, includeApplier: isAdmin(user) && !primary };
}
