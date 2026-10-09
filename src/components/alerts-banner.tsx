"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/hooks/use-current-user";
import { authFetch } from "@/lib/auth/client";
import type { ActiveAlertsResponse } from "./alerts-banner-types";
import {
	ACTIVE_ALERTS_REFRESH_MS,
	parseActiveAlerts,
	readDismissedSignature,
	shouldShowAlertsBanner,
	storeDismissedSignature,
} from "./alerts-banner-utils";

async function fetchActiveAlerts(): Promise<ActiveAlertsResponse> {
	const response = await authFetch("/api/admin/alerts/active", { cache: "no-store" });
	if (!response.ok) throw new Error(`Active alerts request failed (${response.status})`);
	return parseActiveAlerts(await response.json());
}

function browserStorage(): Storage | undefined {
	try {
		return typeof window === "undefined" ? undefined : window.localStorage;
	} catch {
		return undefined;
	}
}

export function AlertsBanner() {
	const isAdmin = useCurrentUser()?.role === "admin";
	const [dismissed, setDismissed] = useState(() => readDismissedSignature(browserStorage()));
	const { data } = useQuery({
		queryKey: ["admin-alerts-active"],
		queryFn: fetchActiveAlerts,
		enabled: isAdmin,
		refetchInterval: ACTIVE_ALERTS_REFRESH_MS,
		// The app-wide defaults disable refetch on mount; alerts must be current whenever the dashboard is shown.
		refetchOnMount: "always",
		refetchOnWindowFocus: false,
		retry: false,
	});

	if (!isAdmin || !shouldShowAlertsBanner(data, dismissed) || !data?.signature) return null;
	const signature = data.signature;

	return (
		<section
			aria-label="Operational alerts"
			className="mx-2 mb-2 flex shrink-0 items-start gap-3 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 md:ml-0 md:mr-4"
		>
			<TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-blue-700" aria-hidden="true" />
			<div className="min-w-0 flex-1">
				<p className="font-medium">Operational alerts need attention</p>
				<ul className="mt-1 flex flex-wrap gap-x-5 gap-y-1">
					{data.alerts.map((alert) => (
						<li key={alert.rule} className="flex items-center gap-2">
							<Link href={alert.href} className="text-blue-700 underline underline-offset-2 hover:text-blue-800">
								{alert.name}
							</Link>
							<span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-900">
								{alert.count}
							</span>
						</li>
					))}
				</ul>
			</div>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="shrink-0 text-blue-800 hover:bg-blue-100"
				onClick={() => {
					storeDismissedSignature(browserStorage(), signature);
					setDismissed(signature);
				}}
			>
				Dismiss
			</Button>
		</section>
	);
}
