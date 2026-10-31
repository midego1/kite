"use client";

import { useEffect, useState } from "react";
import { loadingRecoveryDelay } from "./loading-recovery-utils";

export function LoadingRecovery({ active }: { active: boolean }) {
	const [expired, setExpired] = useState(false);
	useEffect(() => {
		if (!active) return;
		// Counted from the start of the page, not from this mount: a startup screen that remounts must not push it back.
		const timer = window.setTimeout(() => setExpired(true), loadingRecoveryDelay(performance.now()));
		return () => window.clearTimeout(timer);
	}, [active]);
	if (!active || !expired) return null;
	return (
		<div className="loading-recovery text-center text-sm text-neutral-600">
			<p>Startup is taking longer than expected.</p>
			<button
				type="button"
				className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
				onClick={() => window.location.reload()}
			>
				Reload Kite
			</button>
		</div>
	);
}
