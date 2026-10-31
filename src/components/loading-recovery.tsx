"use client";

import { useEffect, useRef, useState } from "react";
import { type BootCopyResult, bootCopyLabel, copyBootDetails, readBootDetails } from "./boot-trace-utils";
import { type VisibleClock, loadingRecoveryDelay, startVisibleClock, tickVisibleClock } from "./loading-recovery-utils";

/**
 * Started by the first startup screen of the page and shared by every later one, so a screen that remounts never
 * pushes the offer back.
 */
let firstMount: VisibleClock | null = null;

export function LoadingRecovery({ active }: { active: boolean }) {
	const [expired, setExpired] = useState(false);
	useEffect(() => {
		if (!active) return;
		let timer: number | undefined;
		// Counted in visible time: a tab opened in the background does not say "taking longer" the moment it is shown.
		const schedule = () => {
			const now = performance.now();
			const visible = document.visibilityState !== "hidden";
			firstMount = tickVisibleClock(firstMount ?? startVisibleClock(now, visible), now, visible);
			window.clearTimeout(timer);
			if (visible) timer = window.setTimeout(() => setExpired(true), loadingRecoveryDelay(firstMount.visibleMs));
		};
		schedule();
		document.addEventListener("visibilitychange", schedule);
		return () => {
			window.clearTimeout(timer);
			document.removeEventListener("visibilitychange", schedule);
		};
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
			<BootDetails />
		</div>
	);
}

/** The boot trace (boot-trace-utils.ts), folded away: what to send along when reporting a start that hangs. */
function BootDetails() {
	const [snapshot, setSnapshot] = useState(readBootDetails);
	const [copied, setCopied] = useState<BootCopyResult>("failed");
	const lines = useRef<HTMLPreElement>(null);
	if (!snapshot) return null;
	return (
		<details
			className="mt-3 text-left text-xs text-neutral-600"
			onToggle={(event) => {
				if (event.currentTarget.open) setSnapshot(readBootDetails());
			}}
		>
			<summary className="cursor-pointer text-center">Details</summary>
			<pre
				ref={lines}
				data-boot-details
				className="mt-2 max-h-48 overflow-auto font-mono text-[11px] break-words whitespace-pre-wrap"
			>
				{snapshot.text}
			</pre>
			<button
				type="button"
				className="mt-2 rounded-md border border-neutral-300 px-2.5 py-1 hover:bg-neutral-100"
				onClick={() => void copyBootDetails(lines.current).then(setCopied)}
			>
				{bootCopyLabel(copied)}
			</button>
		</details>
	);
}
