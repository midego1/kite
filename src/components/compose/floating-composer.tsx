"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { LazyComposeForm, preloadComposeForm } from "@/components/compose/compose-form-lazy";
import { useCompose } from "@/components/compose/compose-context";

export function FloatingComposer() {
	const { open, draftId, closeComposer } = useCompose();
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

	if (!open) return null;
	return (
		<LazyComposeForm
			key={draftId ?? "new"}
			mode="popup"
			draftIdToLoad={draftId}
			onClose={() => {
				closeComposer();
				if (/^\/drafts\/[^/]+\/?$/.test(pathname)) router.replace("/drafts");
			}}
		/>
	);
}
