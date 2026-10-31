"use client";

import Link from "next/link";
import { useCurrentUser } from "@/hooks/use-current-user";
import type { AgentSettingsResponse } from "./types";

/** Whether chat can run: a provider is set up and, when it is external, the primary admin allowed it to read mail. */
export type ChatProviderState = {
	configured: boolean;
	/** The provider's name while chat is refused for an external provider that is not allowed. */
	externalBlocked: string | null;
};

export const NO_PROVIDER: ChatProviderState = { configured: false, externalBlocked: null };

export function chatProviderState(
	data: Pick<AgentSettingsResponse, "providerConfigured" | "externalProviderBlocked" | "providerLabel">,
): ChatProviderState {
	return {
		configured: data.providerConfigured,
		externalBlocked: data.externalProviderBlocked ? data.providerLabel : null,
	};
}

/**
 * Why chat is off, above the conversation: no provider at all, or an external provider the primary admin has not
 * allowed to read mail. The primary admin gets the link that allows it, everyone else whom to ask.
 */
export function ChatProviderNotice({ provider }: { provider: ChatProviderState }) {
	const user = useCurrentUser();
	const primaryAdmin = user?.role === "admin" && user.isPrimaryAdmin;
	if (!provider.configured)
		return (
			<p className="rounded-2xl border border-amber-100 bg-amber-50 p-3 text-amber-800">
				Configure an AI provider to use chat and auto-drafts.
			</p>
		);
	if (!provider.externalBlocked) return null;
	return (
		<div
			className="space-y-1 rounded-2xl border border-amber-100 bg-amber-50 p-3 text-amber-800"
			data-testid="external-provider-notice"
		>
			<p>
				This assistant uses {provider.externalBlocked}, an external AI provider. The primary admin hasn&apos;t allowed
				sending mail to it, so chat is off.
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

/** Under "Automatically draft replies": the drafts are skipped while the external provider is not allowed. */
export function AutoDraftProviderNote({ enabled, provider }: { enabled: boolean; provider: ChatProviderState }) {
	if (!enabled || !provider.externalBlocked) return null;
	return (
		<p className="text-amber-700">
			Automatic drafts are skipped until the primary admin allows {provider.externalBlocked} to read mail.
		</p>
	);
}
