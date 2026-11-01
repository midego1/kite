"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { LazyComposeForm, preloadComposeForm } from "@/components/compose/compose-form-lazy";
import { useCompose } from "@/components/compose/compose-context";
import { InlineComposerPortal } from "@/components/compose/inline-reply-composer";
import { UndoSendHost } from "@/components/compose/undo-send-host";

export function FloatingComposer() {
	const { open, draftId, placement, closeComposer } = useCompose();
	const pathname = usePathname();
	const router = useRouter();

	// Kept out of the first paint, then fetched while idle so opening Compose is still instant.
	useEffect(() => {
		const preload = () => void preloadComposeForm().catch(() => undefined);
		if (typeof window.requestIdleCallback === "function") {
			const handle = window.requestIdleCallback(preload, { timeout: 5_000 });
			return () => window.cancelIdleCallback(handle);
		}
		const timer = window.setTimeout(preload, 2_000);
		return () => window.clearTimeout(timer);
	}, []);

	// A reply docked in the reader renders through its own host, which outlives the reader while it sends.
	// The undo-send bar is mounted wherever a composer is, because sending closes the composer.
	return (
		<>
			{!open || placement !== "popup" ? (
				<InlineComposerPortal />
			) : (
				<LazyComposeForm
					key={draftId ?? "new"}
					mode="popup"
					draftIdToLoad={draftId}
					onClose={() => {
						closeComposer();
						if (/^\/drafts\/[^/]+\/?$/.test(pathname)) router.replace("/drafts");
					}}
				/>
			)}
			<UndoSendHost />
		</>
	);
}
