"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type MouseEvent } from "react";
import type { DemoClick, DemoHostProps, HomeDemoProps } from "./home-demo-types";

/** A selector for the element that had the focus, so the same button or the search box gets it back after the swap. */
function focusSelector(element: Element | null): string | null {
	if (!(element instanceof HTMLElement)) return null;
	if (element.dataset.action) {
		const parts = [`[data-action="${element.dataset.action}"]`];
		if (element.dataset.id) parts.push(`[data-id="${element.dataset.id}"]`);
		if (element.dataset.view) parts.push(`[data-view="${element.dataset.view}"]`);
		return parts.join("");
	}
	if (element instanceof HTMLInputElement && element.type === "search") return 'input[type="search"]';
	return null;
}

/**
 * Shows the server-rendered frame (its children) and swaps in the live demo once its chunk has loaded: in
 * the browser's idle time shortly after the page is ready, or at once when the visitor hovers, touches,
 * focuses or clicks the frame. The demo's code is never in the page's own bundle. The wrapper stays in
 * place across the swap; the focused element is focused again in the new tree, and a click on a button of
 * the static frame is kept and applied as soon as the demo mounts, so no early click or Tab is lost.
 */
export function HomeDemoHost({ appName, children }: DemoHostProps) {
	const [Demo, setDemo] = useState<ComponentType<HomeDemoProps> | null>(null);
	const [initialAction, setInitialAction] = useState<DemoClick | null>(null);
	const root = useRef<HTMLDivElement>(null);
	const loading = useRef(false);
	const pendingAction = useRef<DemoClick | null>(null);
	const pendingFocus = useRef<string | null>(null);

	const load = () => {
		if (loading.current || typeof window === "undefined") return;
		loading.current = true;
		void import("./home-demo").then((module) => {
			const active = document.activeElement;
			pendingFocus.current = root.current?.contains(active) ? focusSelector(active) : null;
			setInitialAction(pendingAction.current);
			setDemo(() => module.HomeDemo);
		});
	};

	const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
		if (Demo) return;
		const button = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
		if (button) {
			const { action, id, view } = button.dataset;
			pendingAction.current = { action, id, view };
		}
		load();
	};

	useLayoutEffect(() => {
		if (!Demo || !pendingFocus.current) return;
		const target = root.current?.querySelector<HTMLElement>(pendingFocus.current);
		pendingFocus.current = null;
		target?.focus();
	}, [Demo]);

	useEffect(() => {
		if (typeof window === "undefined") return;
		const idle = window.requestIdleCallback as typeof window.requestIdleCallback | undefined;
		if (idle) {
			const handle = idle(load, { timeout: 2500 });
			return () => window.cancelIdleCallback(handle);
		}
		const timer = window.setTimeout(load, 1200);
		return () => window.clearTimeout(timer);
	}, []);

	return (
		<div ref={root} onPointerEnter={load} onTouchStart={load} onFocus={load} onClickCapture={onClickCapture}>
			{Demo ? <Demo appName={appName} initialAction={initialAction} /> : children}
		</div>
	);
}
