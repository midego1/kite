"use client";

import { useCallback, useEffect, useRef, useState, type FocusEvent } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, X } from "lucide-react";
import { KiteGlyph } from "./kite-glyph";
import { SUCCESS_NOTICE_CLASS } from "./notice-styles";
import { once, prefersReducedMotion } from "./reload-flight-utils";
import type { AppliedNoticeExit, AppliedNoticeOrigin, DismissTimer } from "./applied-notice-types";
import {
	APPLIED_NOTICE_STAY_MS,
	createDismissTimer,
	isAppliedNoticeExitEnd,
	planAppliedNoticeExit,
} from "./applied-notice-utils";

const browserClock = {
	now: () => Date.now(),
	setTimeout: (callback: () => void, ms: number) => window.setTimeout(callback, ms),
	clearTimeout: (handle: unknown) => window.clearTimeout(handle as number),
};

interface AppliedNoticeProps {
	summary: string;
	onDismiss: () => void;
	className?: string;
	compact?: boolean;
}

/**
 * The "Database updated" result after a successful run. It stays readable for a few seconds, holding still while
 * the pointer or the keyboard focus is on it and while the tab is hidden, then folds away as a tiny kite lifts off its
 * corner and drifts out of view; the close button takes the same way out at once. The exit is CSS (globals.css,
 * `applied-notice-*`: transforms and opacity only), the kite exists only during the flight and nothing runs while
 * the notice sits still. Reduced motion gets a short fade instead.
 */
export function AppliedNotice({ summary, onDismiss, className, compact = false }: AppliedNoticeProps) {
	const section = useRef<HTMLElement>(null);
	const timer = useRef<DismissTimer | null>(null);
	const [exit, setExit] = useState<{ plan: AppliedNoticeExit; origin: AppliedNoticeOrigin } | null>(null);
	const finish = useRef<(() => void) | null>(null);

	const leave = useCallback(() => {
		if (exit) return;
		// One read of where the box is, so the kite lifts off from its corner even where the box itself is clipped.
		const rect = section.current?.getBoundingClientRect();
		setExit({
			plan: planAppliedNoticeExit(prefersReducedMotion(window.matchMedia?.bind(window))),
			origin: { top: rect?.top ?? 0, right: rect?.right ?? 0 },
		});
	}, [exit]);

	// The countdown, held while the tab is hidden.
	useEffect(() => {
		if (exit) return;
		const countdown = createDismissTimer({ stayMs: APPLIED_NOTICE_STAY_MS, onElapsed: leave }, browserClock);
		timer.current = countdown;
		const onVisibility = () => (document.hidden ? countdown.hold("hidden") : countdown.release("hidden"));
		onVisibility();
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			document.removeEventListener("visibilitychange", onVisibility);
			countdown.cancel();
			timer.current = null;
		};
	}, [exit, leave]);

	// The exit ends with the kite's (or the fade's) `animationend`, or with the fallback timer, whichever comes first.
	useEffect(() => {
		if (!exit) return;
		const done = (finish.current = once(onDismiss));
		const fallback = window.setTimeout(done, exit.plan.fallbackMs);
		return () => window.clearTimeout(fallback);
	}, [exit, onDismiss]);

	const onBlur = (event: FocusEvent<HTMLElement>) => {
		if (!event.currentTarget.contains(event.relatedTarget)) timer.current?.release("focus");
	};
	const onAnimationEnd = (animationName: string) => {
		if (exit && isAppliedNoticeExitEnd(animationName, exit.plan)) finish.current?.();
	};
	const leaving = exit ? (exit.plan.kite ? "applied-notice-leave" : "applied-notice-fade") : "";

	return (
		<>
			<section
				ref={section}
				aria-label="Database updates"
				data-applied-notice={exit ? "leaving" : "shown"}
				className={`${compact ? SUCCESS_NOTICE_CLASS : `flex items-start gap-3 rounded-2xl bg-green-50 px-4 py-3 text-sm text-green-700 ${className ?? ""}`} ${leaving}`}
				onPointerEnter={() => timer.current?.hold("hover")}
				onPointerLeave={() => timer.current?.release("hover")}
				onFocus={() => timer.current?.hold("focus")}
				onBlur={onBlur}
				onAnimationEnd={(event) => onAnimationEnd(event.animationName)}
			>
				<CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
				<div role="status" className="min-w-0 flex-1">
					<p className="font-medium">Database updated</p>
					<p className="mt-1">{summary}</p>
				</div>
				<button
					type="button"
					aria-label="Dismiss"
					onClick={leave}
					disabled={Boolean(exit)}
					className={`-mr-1 -mt-0.5 shrink-0 rounded-md p-1 opacity-70 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current ${compact ? "" : "p-1.5"}`}
				>
					<X className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} aria-hidden="true" />
				</button>
			</section>
			{exit?.plan.kite &&
				createPortal(
					<AppliedNoticeKite origin={exit.origin} compact={compact} onEnd={onAnimationEnd} />,
					document.body,
				)}
		</>
	);
}

/**
 * The kite that lifts off the notice. It is fixed to the page at the notice's top right corner, so the sidebar's
 * scrolling notice list cannot clip it, and goes away with the notice.
 */
function AppliedNoticeKite({
	origin,
	compact,
	onEnd,
}: {
	origin: AppliedNoticeOrigin;
	compact: boolean;
	onEnd: (animationName: string) => void;
}) {
	const size = compact ? 28 : 36;
	return (
		<svg
			data-applied-notice-flight
			aria-hidden="true"
			className="applied-notice-kite pointer-events-none fixed z-[10000]"
			style={{ top: origin.top - size * 0.4, left: origin.right - size * 0.9, width: size, height: size * 1.25 }}
			viewBox="-20 0 136 170"
			fill="none"
			onAnimationEnd={(event) => onEnd(event.animationName)}
		>
			<KiteGlyph fillId="applied-notice-fill" tailClassName="reload-flight-tail" />
		</svg>
	);
}
