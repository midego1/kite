import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { ensureBookingUsername } from "@/lib/booking/username";
import { getEnv } from "@/lib/cloudflare";
import { pendingHandler, unavailableRefsHandler } from "../handler-helpers";
import type { CapabilityHandler } from "../module-types";

export const bookingHandlers: Record<string, CapabilityHandler> = {
	workingHours: pendingHandler("The working hours service"),
	resolveRefs: unavailableRefsHandler,
	userCreated: async (input) => {
		const userId = (input as { userId: string }).userId;
		const env = getEnv();
		const [user] = await getDb(env).select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
		if (!user) return { handled: false };
		await ensureBookingUsername(env, userId, user.email);
		return { handled: true };
	},
};
