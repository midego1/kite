"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useReaderFont } from "@/components/messages/use-reader-font";
import { useDarkTheme } from "./use-dark-theme";
import { buildEmailFrameDocument, EMAIL_FRAME_SANDBOX, emailFrameColorScheme } from "./email-html-frame-utils";
import type { EmailHtmlFrameProps, RemoteImagesNoticeProps } from "./email-html-frame-types";

export function EmailHtmlFrame({
	html,
	title = "Message body",
	muted,
	original = false,
	className,
}: EmailHtmlFrameProps) {
	const frame = useRef<HTMLIFrameElement | null>(null);
	const [height, setHeight] = useState(0);
	const dark = useDarkTheme();
	const scheme = emailFrameColorScheme(html, { dark, original });
	const font = useReaderFont();
	const srcDoc = useMemo(
		() => buildEmailFrameDocument(html, { dark, muted, original, font }),
		[html, dark, muted, original, font],
	);

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
			<iframe
				ref={frame}
				title={title}
				sandbox={EMAIL_FRAME_SANDBOX}
				referrerPolicy="no-referrer"
				srcDoc={srcDoc}
				style={{ height, colorScheme: scheme }}
				className={cn("block w-full border-0 bg-transparent", dark && scheme === "light" && "rounded-lg", className)}
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
