"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TriangleAlert, X } from "lucide-react";
import { NOTICE_LINK_CLASS, WARNING_NOTICE_CLASS } from "./notice-styles";
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
		<section aria-label="Operational alerts" className={WARNING_NOTICE_CLASS}>
			<TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
			<div className="min-w-0 flex-1">
				<p className="truncate font-medium">Operational alerts need attention</p>
				<ul className="mt-1 flex flex-col gap-0.5">
					{data.alerts.map((alert) => (
						<li key={alert.rule} className="flex min-w-0 items-center gap-1.5">
							<Link href={alert.href} title={alert.name} className={`min-w-0 truncate ${NOTICE_LINK_CLASS}`}>
								{alert.name}
							</Link>
							<span className="shrink-0 tabular-nums opacity-80">{alert.count}</span>
						</li>
					))}
				</ul>
			</div>
			<button
				type="button"
				aria-label="Dismiss"
				title="Dismiss"
				className="-mr-1.5 -mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-[#f59e0b]/15"
				onClick={() => {
					storeDismissedSignature(browserStorage(), signature);
					setDismissed(signature);
				}}
			>
				<X className="h-3.5 w-3.5" aria-hidden="true" />
			</button>
		</section>
	);
}
