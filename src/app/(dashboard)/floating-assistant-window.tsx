"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { LazyAgentPanel, preloadAgentPanel } from "@/components/agent/agent-panel-lazy";
import { useCompose } from "@/components/compose/compose-context";
import { readInitialColumnWidth, saveColumnWidth } from "@/components/column-width-preferences";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { useCurrentUser } from "@/hooks/use-current-user";

type WindowSize = { width: number; height: number };

const DEFAULT_SIZE: WindowSize = { width: 440, height: 620 };
const MIN_SIZE: WindowSize = { width: 340, height: 360 };
const MAX_SIZE: WindowSize = { width: 1200, height: 1400 };

// Keeps the window clear of the left edge and the header.
function clampWindowSize(size: WindowSize): WindowSize {
	const roomWidth = typeof window === "undefined" ? MAX_SIZE.width : window.innerWidth - 64;
	const roomHeight = typeof window === "undefined" ? MAX_SIZE.height : window.innerHeight - 88;
	return {
		width: Math.round(Math.max(MIN_SIZE.width, Math.min(MAX_SIZE.width, roomWidth, size.width))),
		height: Math.round(Math.max(MIN_SIZE.height, Math.min(MAX_SIZE.height, roomHeight, size.height))),
	};
}

function readSavedSize(): WindowSize {
	return clampWindowSize({
		width: readInitialColumnWidth("assistant-window-width", DEFAULT_SIZE.width, MIN_SIZE.width, MAX_SIZE.width),
		height: readInitialColumnWidth("assistant-window-height", DEFAULT_SIZE.height, MIN_SIZE.height, MAX_SIZE.height),
	});
}

/** The "Ask Kite AI" bubble and, when open, the chat window above it. */
export function FloatingAssistant({
	open,
	fullSize,
	onToggle,
	onToggleFullSize,
	onClose,
}: {
	open: boolean;
	fullSize: boolean;
	onToggle: () => void;
	onToggleFullSize: () => void;
	onClose: () => void;
}) {
	const { open: composing } = useCompose();
	// A closed bubble would sit on the composer's send row, so it waits until the composer is gone.
	const showBubble = !fullSize && (open || !composing);
	return (
		<>
			{open && <FloatingAssistantWindow fullSize={fullSize} onToggleFullSize={onToggleFullSize} onClose={onClose} />}
			{showBubble && (
				<button
					type="button"
					onPointerEnter={() => void preloadAgentPanel().catch(() => undefined)}
					onClick={onToggle}
					aria-label={open ? "Minimize Kite AI" : "Ask Kite AI"}
					aria-expanded={open}
					aria-controls={open ? "email-assistant-panel" : undefined}
					className="fixed bottom-6 right-8 z-[44] flex h-12 items-center gap-2.5 rounded-full bg-blue-900 pl-4 pr-3 text-sm font-medium text-blue-50 shadow-lg shadow-blue-900/25 transition-colors hover:bg-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2"
				>
					<Sparkles className="h-4 w-4" aria-hidden="true" />
					<span>Ask Kite AI</span>
					<span className="h-5 w-px bg-blue-50/25" aria-hidden="true" />
					{open ? (
						<ChevronDown className="h-4 w-4" aria-hidden="true" />
					) : (
						<ChevronUp className="h-4 w-4" aria-hidden="true" />
					)}
				</button>
			)}
		</>
	);
}

function FloatingAssistantWindow({
	fullSize,
	onToggleFullSize,
	onClose,
}: {
	fullSize: boolean;
	onToggleFullSize: () => void;
	onClose: () => void;
}) {
	const userId = useCurrentUser()?.id ?? null;
	const [size, setSizeState] = useState(DEFAULT_SIZE);
	const sizeRef = useRef(DEFAULT_SIZE);
	const resizeStart = useRef(DEFAULT_SIZE);
	const setSize = (next: WindowSize) => {
		sizeRef.current = next;
		setSizeState(next);
	};

	useLayoutEffect(() => {
		// The saved size lives in localStorage, which only exists in the browser.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		setSize(readSavedSize());
	}, []);

	// The floating composer docks beside this window and reads its width from here.
	useLayoutEffect(() => {
		const root = document.documentElement;
		root.style.setProperty("--assistant-window-width", `${size.width}px`);
		return () => {
			root.style.removeProperty("--assistant-window-width");
		};
	}, [size.width]);

	const resizeProps = {
		onResizeStart: () => {
			resizeStart.current = sizeRef.current;
		},
		onResizeEnd: () => {
			saveColumnWidth(userId, "assistant-window-width", sizeRef.current.width);
			saveColumnWidth(userId, "assistant-window-height", sizeRef.current.height);
		},
	};

	return (
		<div
			className={
				fullSize
					? "fixed left-1/2 top-1/2 z-[45] h-[86vh] w-[min(860px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2"
					: "fixed bottom-[5.5rem] right-8 z-[45] h-[min(var(--assistant-window-height),calc(100vh-88px-5.5rem))] w-[min(var(--assistant-window-width),calc(100vw-32px))] max-md:inset-0 max-md:h-auto max-md:w-auto"
			}
			style={{ "--assistant-window-height": `${size.height}px` } as React.CSSProperties}
		>
			{!fullSize && (
				<>
					<div className="absolute inset-y-0 left-0 z-10 hidden w-0 md:block">
						<ResizeHandle
							label="Resize assistant width"
							{...resizeProps}
							onResize={(delta) =>
								setSize(clampWindowSize({ ...resizeStart.current, width: resizeStart.current.width - delta }))
							}
						/>
					</div>
					<div className="absolute inset-x-0 top-0 z-10 hidden h-0 md:block">
						<ResizeHandle
							label="Resize assistant height"
							orientation="horizontal"
							{...resizeProps}
							onResize={(delta) =>
								setSize(clampWindowSize({ ...resizeStart.current, height: resizeStart.current.height - delta }))
							}
						/>
					</div>
				</>
			)}
			<LazyAgentPanel open fullSize={fullSize} onToggleFullSize={onToggleFullSize} onClose={onClose} />
		</div>
	);
}
