import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { ensureBookingUsername } from "@/lib/booking/username";
import { loadWorkingHours } from "@/lib/booking/working-hours";
import { getEnv } from "@/lib/cloudflare";
import type { CapabilityHandler } from "../module-types";
import { resolveBookingRefs } from "@/lib/booking/refs";

export const bookingHandlers: Record<string, CapabilityHandler> = {
	workingHours: async (input) => (await loadWorkingHours(getEnv(), (input as { userId: string }).userId)) ?? null,
	resolveRefs: resolveBookingRefs,
	userCreated: async (input) => {
		const userId = (input as { userId: string }).userId;
		const env = getEnv();
		const [user] = await getDb(env).select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
		if (!user) return { handled: false };
		await ensureBookingUsername(env, userId, user.email);
		return { handled: true };
	},
};
