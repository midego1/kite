"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Toaster } from "react-hot-toast";
import { clearMailboxClientState } from "@/components/mailbox-provider-utils";
import { BrandingProvider } from "@/components/branding-provider";
import { NewMessagePopup } from "@/components/new-message-popup";
import { ThemeSync } from "@/components/theme-sync";
import { ConfirmDialogHost } from "@/components/ui/confirm-dialog";
import { useMessagePolling } from "@/hooks/use-message-polling";
import { clearMessageClientState } from "@/hooks/utils";
import { clearMessageDetailCache } from "@/lib/messages/detail-cache";
import { AUTH_ME_STALE_EVENT, AUTH_SESSION_CHANGED_EVENT } from "@/lib/auth/client";
import { AUTH_ME_QUERY_KEY } from "@/lib/auth/me-client";

export function Providers({ children }: { children: React.ReactNode }) {
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
		function resetUserScopedState() {
			client.clear();
			clearMailboxClientState();
			clearMessageClientState();
			clearMessageDetailCache();
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
			<BrandingProvider>
				{children}
				<ThemeSync />
				<ConfirmDialogHost />
				<Toaster position="bottom-center" />
				{realtime.notification && (
					<NewMessagePopup notification={realtime.notification} onDismiss={realtime.dismissNotification} />
				)}
			</BrandingProvider>
		</QueryClientProvider>
	);
}
