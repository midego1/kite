"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { AUTH_ME_QUERY_KEY, AUTH_ME_STALE_TIME_MS, fetchAuthMe } from "@/lib/auth/me-client";

/**
 * The shared `/api/auth/me` query. Every component that needs the signed-in
 * account reads this one cache entry instead of issuing its own request.
 */
export function useAuthMe(enabled = true) {
	return useQuery({
		queryKey: AUTH_ME_QUERY_KEY,
		queryFn: fetchAuthMe,
		staleTime: AUTH_ME_STALE_TIME_MS,
		retry: false,
		// The guard renders children after a failed check. Their observers must not
		// restart the query and put the guard back into its pending state.
		retryOnMount: false,
		enabled,
	});
}

/** Refetches the shared session after a change to the signed-in account. */
export function useInvalidateAuthMe() {
	const queryClient = useQueryClient();
	return useCallback(() => queryClient.invalidateQueries({ queryKey: AUTH_ME_QUERY_KEY }), [queryClient]);
}
