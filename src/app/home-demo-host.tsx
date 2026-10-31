"use client";

import { useEffect, useRef, useState, type ComponentType } from "react";
import type { DemoHostProps, HomeDemoProps } from "./home-demo-types";

/**
 * Shows the server-rendered frame (its children) and swaps in the live demo once its chunk has loaded: in
 * the browser's idle time shortly after the page is ready, or at once when the visitor hovers, touches or
 * focuses the frame. The demo's code is never in the page's own bundle.
 */
export function HomeDemoHost({ appName, children }: DemoHostProps) {
	const [Demo, setDemo] = useState<ComponentType<HomeDemoProps> | null>(null);
	const loading = useRef(false);

	const load = () => {
		if (loading.current || typeof window === "undefined") return;
		loading.current = true;
		void import("./home-demo").then((module) => setDemo(() => module.HomeDemo));
	};

	useEffect(() => {
		if (typeof window === "undefined") return;
		const idle = window.requestIdleCallback as typeof window.requestIdleCallback | undefined;
		if (idle) {
			const handle = idle(load, { timeout: 2500 });
			return () => window.cancelIdleCallback(handle);
		}
		const timer = window.setTimeout(load, 1200);
		return () => window.clearTimeout(timer);
		// `load` is stable in meaning: it reads only the ref and the module.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	if (Demo) return <Demo appName={appName} />;
	return (
		<div onPointerEnter={load} onTouchStart={load} onFocus={load}>
			{children}
		</div>
	);
}
