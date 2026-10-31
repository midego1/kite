"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useIsFetching } from "@tanstack/react-query";
import { useBranding } from "@/components/branding-provider";
import { markLoaderMounted } from "@/components/asset-recovery-utils";
import { markBootPhase } from "@/components/boot-trace-utils";
import { PageLoadingContext } from "@/components/page-loading";
import { RouteLoadingBar } from "@/components/route-loading-bar";
import { ReloadReturnKite, ReloadReturnSky } from "@/components/reload-return-scene";
import {
	RELOAD_RETURN_ANNOUNCEMENT,
	RELOAD_RETURN_STATIC_TEXT,
	endReloadReturn,
	isReloadReturnActive,
} from "@/components/reload-return-utils";
import { useSyncedState } from "@/hooks/use-synced-state";
import type { LoadingTransitionProps } from "./loading-transition-types";
import { LoadingRecovery } from "./loading-recovery";
import { StartupSteps } from "./startup-steps";
import { useStartupSteps, useVisibleStartupTime } from "./use-startup-steps";

const MINIMUM_LOADING_TIME = 600;
const COMPLETION_TIME = 220;
const MAXIMUM_DATA_WAIT = 10_000;
/** The overlay's opacity transition (`duration-300`): the kite's return stops once the screen has faded out. */
const OVERLAY_FADE_TIME = 300;
let hasShownInitialLoadingTransition = false;

/**
 * The progress bar with the running step above it and the step log below (use-startup-steps.ts), mounted from the
 * server's screen until the overlay has faded out (`progressMounted`): the icon block never jumps during the fade,
 * the return scene's kite stays until the fade ends (#234), and afterwards nothing the stats store learns re-renders
 * the shell. The kite hangs from the bar's own box, which holds only the kite, the track and the reduced-motion caption.
 */
function StartupProgress({
	ready,
	progress,
	visibleMs,
}: {
	ready: boolean;
	progress: number;
	visibleMs: number | null;
}) {
	const { steps, statusLabel } = useStartupSteps(ready, visibleMs);
	return (
		<div className="w-full">
			<p aria-hidden="true" className="mb-2 flex w-full items-baseline justify-between gap-3 text-sm text-neutral-700">
				<span data-startup-status className="min-w-0 truncate">
					{statusLabel}
				</span>
				<span className="text-xs tabular-nums text-neutral-900">{Math.round(progress)}%</span>
			</p>
			<div className="relative w-full">
				{/* The kite hangs from just above the bar, so the two never cross. */}
				<ReloadReturnKite />
				<div className="reload-return-track h-1.5 overflow-hidden rounded-full bg-blue-100">
					<div
						className="reload-return-progress h-full rounded-full bg-blue-600 transition-[width] duration-200 ease-out"
						style={{ width: `${progress}%` }}
					/>
				</div>
				{/* The reduced-motion caption, below the bar without moving it; the live region above says what happens. */}
				<p aria-hidden="true" className="reload-return-static text-sm">
					{RELOAD_RETURN_STATIC_TEXT}
				</p>
			</div>
			<StartupSteps steps={steps} />
		</div>
	);
}

/**
 * The way out for a main thread that stopped: then no timer runs, so neither "Reload Kite" nor the boot watchdog's
 * box can appear, and only the browser can reload. Pure CSS (`.loader-frozen` in globals.css): the compositor fades
 * it in once the watchdog's heartbeat has stopped restarting its animation for 10 seconds, so it never shows while
 * JavaScript runs. Hidden from assistive technology: without a main thread nothing could announce it, and while
 * one runs it is invisible.
 */
function FrozenNotice() {
	return (
		<p
			aria-hidden="true"
			data-loader-frozen
			className="loader-frozen fixed inset-x-0 bottom-8 mx-auto max-w-sm px-6 text-center text-sm text-neutral-700"
		>
			<span className="font-semibold text-neutral-900">Kite stopped responding.</span> Reload this page to start again.
		</p>
	);
}

/** Rendered before the page: React reached the app behind the screen (the boot trace's phase). */
function ChildrenRendering() {
	markBootPhase("children-rendering");
	return null;
}

/** Rendered after the page: its layout effect runs once the page itself has committed (the boot trace's phase). */
function ChildrenCommitted() {
	useLayoutEffect(() => markBootPhase("children-committed"), []);
	return null;
}

export function LoadingTransition({ children, ready, failure }: LoadingTransitionProps) {
	const branding = useBranding();
	const [showInitialLoader] = useState(() => !hasShownInitialLoadingTransition);
	const [startedAt] = useState(() => Date.now());
	const [progress, setProgress] = useState(8);
	const [loaderVisible, setLoaderVisible] = useState(showInitialLoader);
	const [contentVisible, setContentVisible] = useState(!showInitialLoader);
	const [initialLoadComplete, setInitialLoadComplete] = useState(!showInitialLoader);
	const [iconUrl, setIconUrl] = useSyncedState(branding.iconUrl);
	const [pageMounted, setPageMounted] = useState(false);
	const [pendingLoads, setPendingLoads] = useState(0);
	const [dataWaitExpired, setDataWaitExpired] = useState(false);
	const loadingIds = useRef(new Set<string>());
	const fetchingQueries = useIsFetching();
	// The step log's last line: the visible time the start took, known once the screen completes.
	const [visibleMs, setVisibleMs] = useState<number | null>(null);
	const readVisibleMs = useVisibleStartupTime();
	// The bar, the step log and the return kite stay until the overlay has faded out; then they leave the tree.
	const [progressMounted, setProgressMounted] = useState(showInitialLoader);

	const reportLoading = useCallback((id: string, loading: boolean) => {
		if (loading) loadingIds.current.add(id);
		else loadingIds.current.delete(id);
		setPendingLoads(loadingIds.current.size);
	}, []);
	const loadingContext = useMemo(() => ({ reportLoading }), [reportLoading]);
	const canComplete = ready && pageMounted && (dataWaitExpired || (pendingLoads === 0 && fetchingQueries === 0));
	const overlayVisible = loaderVisible || failure != null;

	// The boot watchdog (asset-recovery-utils.ts) leaves a startup screen that React runs alone. A layout effect
	// runs in the same task as the hydration commit, so the watchdog never sees a committed screen as the server's;
	// a render alone could still be thrown away, so it is not enough.
	useLayoutEffect(() => markLoaderMounted(), []);

	// A failed startup ends the kite's return (reload-return-scene.tsx) before the failure paints: the plain light
	// screen carries the failure's own colours, and a later ordinary reload must not replay the return.
	useLayoutEffect(() => {
		if (failure != null && isReloadReturnActive()) endReloadReturn();
	}, [failure]);

	useEffect(() => {
		if (ready) markBootPhase("auth-ready");
	}, [ready]);

	useEffect(() => {
		if (canComplete) markBootPhase("can-complete");
	}, [canComplete]);

	useEffect(() => {
		if (canComplete) return;
		const timer = window.setInterval(() => {
			setProgress((current) => Math.min(92, current + Math.max(1, (92 - current) * 0.08)));
		}, 90);
		return () => window.clearInterval(timer);
	}, [canComplete]);

	useEffect(() => {
		if (!ready) return;
		const timer = window.setTimeout(() => setPageMounted(true), 50);
		return () => window.clearTimeout(timer);
	}, [ready]);

	useEffect(() => {
		if (!ready) return;
		const timer = window.setTimeout(() => setDataWaitExpired(true), MAXIMUM_DATA_WAIT);
		return () => window.clearTimeout(timer);
	}, [ready]);

	useEffect(() => {
		if (!canComplete) return;
		const remaining = showInitialLoader ? Math.max(0, MINIMUM_LOADING_TIME - (Date.now() - startedAt)) : 0;
		const completeTimer = window.setTimeout(() => {
			setProgress(100);
			setVisibleMs(readVisibleMs());
		}, remaining);
		const revealTimer = window.setTimeout(() => {
			if (showInitialLoader) {
				hasShownInitialLoadingTransition = true;
				setLoaderVisible(false);
				setContentVisible(true);
			}
			setInitialLoadComplete(true);
			markBootPhase("complete");
		}, remaining + COMPLETION_TIME);
		// After a reload to a new version the screen showed the kite's return (reload-return-scene.tsx): the app is
		// up, so its marker is cleared and the scene stops once the screen has faded, not before.
		const returnTimer = isReloadReturnActive()
			? window.setTimeout(endReloadReturn, remaining + COMPLETION_TIME + OVERLAY_FADE_TIME)
			: null;
		const unmountTimer = window.setTimeout(
			() => setProgressMounted(false),
			remaining + COMPLETION_TIME + OVERLAY_FADE_TIME,
		);
		return () => {
			window.clearTimeout(completeTimer);
			window.clearTimeout(revealTimer);
			window.clearTimeout(unmountTimer);
			if (returnTimer !== null) window.clearTimeout(returnTimer);
		};
	}, [canComplete, showInitialLoader, startedAt, readVisibleMs]);

	const showTopLoadingBar = initialLoadComplete && failure == null && (!ready || pendingLoads > 0);

	return (
		<PageLoadingContext.Provider value={loadingContext}>
			<div className="relative min-h-dvh bg-[#f6f8fc]">
				{showTopLoadingBar && <RouteLoadingBar />}
				{ready && (
					<div className={`min-h-dvh transition-opacity duration-300 ${contentVisible ? "opacity-100" : "opacity-0"}`}>
						<ChildrenRendering />
						{children}
						<ChildrenCommitted />
					</div>
				)}
				<div
					data-loading-overlay
					role={loaderVisible && failure == null ? "status" : undefined}
					aria-hidden={overlayVisible ? undefined : true}
					className={`fixed inset-0 z-[100] flex items-center justify-center bg-[#f6f8fc] transition-opacity duration-300 ${
						overlayVisible ? "opacity-100" : "pointer-events-none opacity-0"
					}`}
				>
					{/* Shown only after a reload from the "Kite was updated" notice; otherwise display: none. */}
					<ReloadReturnSky />
					<div className="relative flex w-80 flex-col items-center gap-6">
						<div className="reload-return-hidden flex flex-col items-center gap-3">
							<img
								src={iconUrl}
								onError={() => setIconUrl("/icon-96.png")}
								alt=""
								className="reload-return-hidden h-20 w-20 rounded-2xl object-contain"
							/>
							<span aria-hidden="true" className="text-xl font-bold tracking-tight text-neutral-900">
								{branding.appName}
							</span>
						</div>
						{failure ?? (
							<>
								{loaderVisible && (
									<>
										<span className="sr-only reload-return-hidden">Loading</span>
										<span className="sr-only reload-return-only">{RELOAD_RETURN_ANNOUNCEMENT}</span>
										<FrozenNotice />
									</>
								)}
								{progressMounted && <StartupProgress ready={ready} progress={progress} visibleMs={visibleMs} />}
								<LoadingRecovery active={loaderVisible} />
							</>
						)}
					</div>
				</div>
			</div>
		</PageLoadingContext.Provider>
	);
}
