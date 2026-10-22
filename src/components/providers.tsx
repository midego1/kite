"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Toaster } from "react-hot-toast";
import { clearMailboxClientState } from "@/components/mailbox-provider-utils";
import { BrandingProvider } from "@/components/branding-provider";
import type { Branding } from "@/lib/branding/types";
import { CopyCodeHost } from "@/components/copy-code-host";
import { ModuleNoticeHost } from "@/components/module-notice-host";
import { NewMessagePopup } from "@/components/new-message-popup";
import { ThemeSync } from "@/components/theme-sync";
import { UpdateAvailableHost } from "@/components/update-available-host";
import { ConfirmDialogHost } from "@/components/ui/confirm-dialog";
import { useMessagePolling } from "@/hooks/use-message-polling";
import { clearMessageClientState } from "@/hooks/utils";
import { clearMessageDetailCache } from "@/lib/messages/detail-cache";
import { AUTH_ME_STALE_EVENT, AUTH_SESSION_CHANGED_EVENT } from "@/lib/auth/client";
import { AUTH_ME_QUERY_KEY } from "@/lib/auth/me-client";
import type { AuthSessionChangedDetail } from "@/lib/auth/client-types";
import { clearAppBadge } from "@/lib/app-badge-utils";

export function Providers({ children, initialBranding }: { children: React.ReactNode; initialBranding?: Branding }) {
	const realtime = useMessagePolling();

	const [client] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: {
						refetchOnMount: false,
						refetchOnReconnect: false,
						refetchOnWindowFocus: false,
						staleTime: 60_000,
					},
				},
			}),
	);

	useEffect(() => {
		function resetUserScopedState(event: Event) {
			client.clear();
			clearMailboxClientState();
			clearMessageClientState();
			clearMessageDetailCache();
			// The dashboard layout outlives an account switch, so its all-mailbox counts (the app badge) would keep the old account's number.
			if ((event as CustomEvent<AuthSessionChangedDetail>).detail?.authenticated) {
				void clearAppBadge(navigator);
				window.dispatchEvent(new Event("kite:message-counts-changed"));
			}
		}

		function refreshCurrentAccount() {
			void client.invalidateQueries({ queryKey: AUTH_ME_QUERY_KEY });
		}

		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, resetUserScopedState);
		window.addEventListener(AUTH_ME_STALE_EVENT, refreshCurrentAccount);
		return () => {
			window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, resetUserScopedState);
			window.removeEventListener(AUTH_ME_STALE_EVENT, refreshCurrentAccount);
		};
	}, [client]);

	return (
		<QueryClientProvider client={client}>
			<BrandingProvider initialBranding={initialBranding}>
				{children}
				<ThemeSync />
				<ConfirmDialogHost />
				<CopyCodeHost />
				<Toaster position="bottom-center" />
				<ModuleNoticeHost />
				<UpdateAvailableHost />
				{/* A live region without role="status": specs and pages look up the single status line by role. */}
				<div aria-live="polite" aria-atomic="true">
					{realtime.notification && (
						<NewMessagePopup notification={realtime.notification} onDismiss={realtime.dismissNotification} />
					)}
				</div>
			</BrandingProvider>
		</QueryClientProvider>
	);
}
