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

const MINIMUM_LOADING_TIME = 600;
const COMPLETION_TIME = 220;
const MAXIMUM_DATA_WAIT = 10_000;
/** The overlay's opacity transition (`duration-300`): the kite's return stops once the screen has faded out. */
const OVERLAY_FADE_TIME = 300;
let hasShownInitialLoadingTransition = false;

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
		const completeTimer = window.setTimeout(() => setProgress(100), remaining);
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
		return () => {
			window.clearTimeout(completeTimer);
			window.clearTimeout(revealTimer);
			if (returnTimer !== null) window.clearTimeout(returnTimer);
		};
	}, [canComplete, showInitialLoader, startedAt]);

	const showTopLoadingBar = initialLoadComplete && failure == null && (!ready || pendingLoads > 0);

	return (
		<PageLoadingContext.Provider value={loadingContext}>
			<div className="relative min-h-dvh bg-[#f6f8fc]">
				{showTopLoadingBar && <RouteLoadingBar />}
				{ready && (
					<div className={`min-h-dvh transition-opacity duration-300 ${contentVisible ? "opacity-100" : "opacity-0"}`}>
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
					<div className={`relative flex flex-col items-center gap-6 ${failure == null ? "w-64" : "w-80"}`}>
						<img
							src={iconUrl}
							onError={() => setIconUrl("/icon-96.png")}
							alt=""
							className="reload-return-hidden h-20 w-20 rounded-2xl object-contain"
						/>
						{failure ?? (
							<>
								{loaderVisible && (
									<>
										<span className="sr-only reload-return-hidden">Loading</span>
										<span className="sr-only reload-return-only">{RELOAD_RETURN_ANNOUNCEMENT}</span>
									</>
								)}
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
								<LoadingRecovery active={loaderVisible} />
							</>
						)}
					</div>
				</div>
			</div>
		</PageLoadingContext.Provider>
	);
}
