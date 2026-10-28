"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useCurrentUser } from "@/hooks/use-current-user";
import { authFetch } from "@/lib/auth/client";
import type { TelemetrySaveResult, TelemetryStatus } from "@/lib/telemetry/types";

/** One cache for the Admin → General card and the notice, so a choice made in one shows in the other. */
const TELEMETRY_STATUS_QUERY_KEY = ["admin", "telemetry"];

export type TelemetryUpdate = { enabled: boolean } | { notice: "shown" | "dismissed" };

async function loadTelemetryStatus(): Promise<TelemetryStatus> {
	const response = await authFetch("/api/admin/telemetry", { cache: "no-store" });
	const data = (await response.json().catch(() => ({}))) as TelemetryStatus & { error?: string };
	if (!response.ok) throw new Error(data.error ?? "Could not load usage statistics");
	return data;
}

async function saveTelemetry(update: TelemetryUpdate): Promise<TelemetrySaveResult> {
	const response = await authFetch("/api/admin/telemetry", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(update),
	});
	const data = (await response.json().catch(() => ({}))) as TelemetrySaveResult & { error?: string };
	if (!response.ok) throw new Error(data.error ?? "Could not save usage statistics");
	return data;
}

/** The owner's usage statistics status (`GET /api/admin/telemetry`) and the one way to change it. */
export function useTelemetryStatus() {
	const user = useCurrentUser();
	const owner = user?.role === "admin" && user.isPrimaryAdmin;
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: TELEMETRY_STATUS_QUERY_KEY,
		queryFn: loadTelemetryStatus,
		enabled: owner,
		refetchOnWindowFocus: false,
		retry: false,
	});
	const save = useMutation({
		mutationFn: saveTelemetry,
		onSuccess: (status) => queryClient.setQueryData(TELEMETRY_STATUS_QUERY_KEY, status),
	});
	return { owner, query, save };
}

/**
 * The one-time notice of an install whose owner never chose. The first time it is due, it records that it was
 * shown, which fixes the start day, and only then appears, so the date it names is the stored one.
 */
export function useTelemetryNotice() {
	const { owner, query, save } = useTelemetryStatus();
	const status = query.data;
	const unseen = Boolean(owner && status?.notice && !status.startDay);
	const { mutate, isIdle } = save;
	useEffect(() => {
		if (unseen && isIdle) mutate({ notice: "shown" });
	}, [unseen, isIdle, mutate]);
	const startDay = owner && status?.notice ? status.startDay : null;
	return { startDay, save };
}
