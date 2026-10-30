"use client";

import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import type { ReloadFlightProps } from "./reload-flight-types";
import {
	RELOAD_FLIGHT_ANNOUNCEMENT,
	RELOAD_FLIGHT_EXPIRE_MS,
	isFlightEnd,
	once,
	planReloadFlight,
	prefersReducedMotion,
} from "./reload-flight-utils";

function reloadPage() {
	window.location.reload();
}

/**
 * The reload to a new version: the kite lifts off the page, sways up and to the right out of view while the page
 * fades to its background, then the page reloads. Pure CSS (globals.css, `reload-flight-*`), so it costs nothing
 * when idle. The reload never waits on the animation: a fallback timer fires it even if `animationend` never comes,
 * and reduced motion reloads at once. The live region is mounted from the start, so "Reloading…" arrives as a change
 * and is announced.
 */
export function ReloadFlight({ active, onReload = reloadPage, onExpire }: ReloadFlightProps) {
	// Decided when the flight starts (a click, so in the browser) and kept until the page is gone; idle and on the
	// server nothing is read.
	const plan = useMemo(
		() => planReloadFlight({ reducedMotion: active && prefersReducedMotion(window.matchMedia?.bind(window)) }),
		[active],
	);
	// Shared by the flight's end and the fallback timer, so the page reloads once however the flight ends.
	const fire = useRef<(() => void) | null>(null);
	// The latest callbacks, read when a timer fires: a new function identity must not restart the timers.
	const latest = useRef({ onReload, onExpire });
	useEffect(() => {
		latest.current = { onReload, onExpire };
	});

	useEffect(() => {
		if (!active) {
			fire.current = null;
			return;
		}
		const reload = (fire.current = once(() => latest.current.onReload()));
		// A reload that never replaced the page was cancelled: take the scene down and let the caller start over.
		const expire = window.setTimeout(() => latest.current.onExpire?.(), RELOAD_FLIGHT_EXPIRE_MS);
		if (!plan.animate) {
			reload();
			return () => window.clearTimeout(expire);
		}
		const timer = window.setTimeout(reload, plan.fallbackMs);
		return () => {
			window.clearTimeout(timer);
			window.clearTimeout(expire);
		};
	}, [active, plan]);

	return (
		<>
			{/* A live region without a role: a second `status` would make every unqualified status lookup ambiguous. */}
			<div aria-live="assertive" aria-atomic="true" className="sr-only">
				{active ? RELOAD_FLIGHT_ANNOUNCEMENT : ""}
			</div>
			{active && plan.animate && createPortal(<ReloadFlightScene onEnd={() => fire.current?.()} />, document.body)}
		</>
	);
}

/** The scene sits above every overlay (toasts are at 9999) and swallows clicks while the page is on its way out (`pointer-events-auto` keeps that true under a modal that sets `pointer-events: none` on the body). */
function ReloadFlightScene({ onEnd }: { onEnd: () => void }) {
	return (
		<div
			data-reload-flight
			aria-hidden="true"
			className="reload-flight pointer-events-auto fixed inset-0 z-[10000] flex items-center justify-center overflow-hidden"
		>
			<div className="reload-flight-fade absolute inset-0 bg-background" />
			<svg
				className="reload-flight-kite relative"
				viewBox="-20 0 136 170"
				fill="none"
				onAnimationEnd={(event) => {
					if (isFlightEnd(event.animationName)) onEnd();
				}}
			>
				<defs>
					<linearGradient id="reload-flight-fill" x1="14" y1="8" x2="80" y2="88" gradientUnits="userSpaceOnUse">
						<stop stopColor="#7fa2ff" />
						<stop offset="1" stopColor="#9b7bf7" />
					</linearGradient>
				</defs>
				{/* The tail trails from the kite's lower tip and sways on its own, slightly behind the kite. */}
				<g className="reload-flight-tail" stroke="#9b7bf7" strokeWidth="2.5" strokeLinecap="round">
					<path d="M28 91 C 20 108, 4 112, -2 134 S -10 158, -14 166" opacity="0.8" />
					<path d="M12 112 l-8 -6 M12 112 l-9 4" />
					<path d="M-2 134 l-8 -5 M-2 134 l-9 5" />
					<path d="M-10 156 l-8 -5 M-10 156 l-8 5" />
				</g>
				{/* The logo in public/kite.svg. */}
				<path
					d="M62 5 L85 50 L28 91 L11 25 Z"
					fill="url(#reload-flight-fill)"
					stroke="url(#reload-flight-fill)"
					strokeWidth="3"
					strokeLinejoin="round"
				/>
				<path d="M62 5 L11 25 L49 37.9 Z" fill="#ffffff" fillOpacity="0.14" />
				<path d="M85 50 L28 91 L49 37.9 Z" fill="#4f46e5" fillOpacity="0.12" />
				<path d="M11 25 L85 50 M62 5 L28 91" stroke="#ffffff" strokeWidth="3.5" strokeLinecap="round" />
			</svg>
		</div>
	);
}
