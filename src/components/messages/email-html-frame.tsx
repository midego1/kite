"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ImageOff, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { buildEmailFrameDocument, EMAIL_FRAME_SANDBOX, hasOwnBackground } from "./email-html-frame-utils";
import type { EmailHtmlFrameProps, RemoteImagesNoticeProps } from "./email-html-frame-types";

function subscribeToTheme(onChange: () => void) {
	const observer = new MutationObserver(onChange);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
	return () => observer.disconnect();
}

function useDarkTheme(): boolean {
	return useSyncExternalStore(
		subscribeToTheme,
		() => document.documentElement.classList.contains("dark"),
		() => false,
	);
}

export function EmailHtmlFrame({ html, title = "Message body", muted, className }: EmailHtmlFrameProps) {
	const frame = useRef<HTMLIFrameElement | null>(null);
	const [height, setHeight] = useState(0);
	const dark = useDarkTheme();
	const [original, setOriginal] = useState(false);
	const designed = dark && hasOwnBackground(html);
	const srcDoc = useMemo(() => buildEmailFrameDocument(html, { dark, muted, original }), [html, dark, muted, original]);

	const pendingFrame = useRef(0);

	const measure = useCallback(() => {
		// Resizing the iframe inside the observer callback triggers "ResizeObserver loop" errors.
		cancelAnimationFrame(pendingFrame.current);
		pendingFrame.current = requestAnimationFrame(() => {
			const root = frame.current?.contentDocument?.documentElement;
			if (!root) return;
			const next = Math.ceil(root.scrollHeight);
			setHeight((current) => (current === next ? current : next));
		});
	}, []);

	useEffect(() => {
		const element = frame.current;
		if (!element) return;
		let observer: ResizeObserver | null = null;
		let observedDocument: Document | null = null;
		const pending = pendingFrame;

		function attach() {
			const doc = element?.contentDocument;
			if (!doc || doc === observedDocument) return;
			observer?.disconnect();
			observedDocument = doc;
			// An observer from the frame's own realm keeps resize-loop notices out of the parent window.
			const FrameResizeObserver =
				(doc.defaultView as (Window & typeof globalThis) | null)?.ResizeObserver ?? ResizeObserver;
			observer = new FrameResizeObserver(measure);
			observer.observe(doc.body ?? doc.documentElement);
			// Quote toggles and late images change the height without resizing the frame.
			doc.addEventListener("toggle", measure, true);
			doc.addEventListener("load", measure, true);
			measure();
		}

		element.addEventListener("load", attach);
		attach();
		return () => {
			element.removeEventListener("load", attach);
			observer?.disconnect();
			cancelAnimationFrame(pending.current);
		};
	}, [measure]);

	return (
		<>
			{designed && !muted && (
				<div className="mb-2 flex justify-end">
					<button
						type="button"
						onClick={() => setOriginal((current) => !current)}
						aria-pressed={original}
						className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
					>
						{original ? (
							<Moon className="h-3.5 w-3.5" aria-hidden="true" />
						) : (
							<Sun className="h-3.5 w-3.5" aria-hidden="true" />
						)}
						{original ? "Dark colours" : "Original colours"}
					</button>
				</div>
			)}
			<iframe
				ref={frame}
				title={title}
				sandbox={EMAIL_FRAME_SANDBOX}
				referrerPolicy="no-referrer"
				srcDoc={srcDoc}
				style={{ height }}
				className={cn("block w-full border-0 bg-transparent", designed && "rounded-lg", className)}
			/>
		</>
	);
}

export function RemoteImagesNotice({ onShow }: RemoteImagesNoticeProps) {
	return (
		<div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
			<ImageOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
			<span className="flex-1">Remote images are hidden to protect your privacy.</span>
			<button type="button" className="font-medium text-blue-600 hover:underline" onClick={onShow}>
				Show images
			</button>
		</div>
	);
}
