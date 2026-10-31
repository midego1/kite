"use client";

import Link from "next/link";
import { useCurrentUser } from "@/hooks/use-current-user";

/**
 * Chat is off because the assistant uses an external provider the primary admin has not allowed to read mail; the
 * primary admin gets the link that allows it, everyone else whom to ask.
 */
export function ExternalProviderNotice({ providerLabel }: { providerLabel: string }) {
	const user = useCurrentUser();
	const primaryAdmin = user?.role === "admin" && user.isPrimaryAdmin;
	return (
		<div
			className="space-y-1 rounded-2xl border border-amber-100 bg-amber-50 p-3 text-amber-800"
			data-testid="external-provider-notice"
		>
			<p>
				This assistant uses {providerLabel}, an external AI provider. The primary admin hasn&apos;t allowed sending mail
				to it, so chat is off.
			</p>
			{primaryAdmin ? (
				<Link href="/agent" className="font-medium text-blue-700 hover:underline">
					Allow it in Admin → Agent
				</Link>
			) : (
				<p>Ask the primary admin to allow it in Admin → Agent.</p>
			)}
		</div>
	);
}
