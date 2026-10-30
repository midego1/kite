"use client";

import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { KiteGlyph } from "./kite-glyph";
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
				<KiteGlyph fillId="reload-flight-fill" tailClassName="reload-flight-tail" />
			</svg>
		</div>
	);
}
