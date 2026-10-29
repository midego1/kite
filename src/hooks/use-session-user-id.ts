"use client";

import { useEffect, useState } from "react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { AUTH_ME_QUERY_KEY } from "@/lib/auth/me-client";
import type { AuthMeResponse } from "@/lib/auth/me-client-types";

/**
 * Reads the session that the guards and pages already load rather than requesting
 * it, so public pages (sign-in, booking, shared Drive links) make no extra call.
 * It watches the cache itself because sign-in and account switches clear it.
 * Cache events also fire while other components render (a `useQuery` observer
 * attaching), so the state update waits for a microtask instead of running
 * inside their render.
 */
function readSessionUserId(client: QueryClient): string | null {
	return client.getQueryData<AuthMeResponse | null>(AUTH_ME_QUERY_KEY)?.user?.id ?? null;
}

export function useSessionUserId(): string | null {
	const client = useQueryClient();
	const [userId, setUserId] = useState(() => readSessionUserId(client));

	useEffect(() => {
		let scheduled = false;
		const sync = () => {
			scheduled = false;
			setUserId(readSessionUserId(client));
		};
		const schedule = () => {
			if (scheduled) return;
			scheduled = true;
			queueMicrotask(sync);
		};
		schedule();
		return client.getQueryCache().subscribe(schedule);
	}, [client]);

	return userId;
}
