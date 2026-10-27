"use client";

import { ChevronUp, Forward, Maximize2, Minimize2, Minus, Reply, SquareArrowOutUpRight, X } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ComposeThreading } from "./types";

/** The composer's title: what it is writing, or that its draft is loading or saved. */
export function composeTitle({
	loadingDraft,
	threading,
	subject,
	draftId,
}: {
	loadingDraft: boolean;
	threading: ComposeThreading | null;
	subject: string;
	draftId: string | null;
}) {
	if (loadingDraft) return "Loading draft";
	if (threading?.inReplyTo) return "Reply";
	if (/^fwd?:/i.test(subject)) return "Forward";
	return draftId ? "Draft saved" : "New Message";
}

type ComposeHeaderProps = {
	mode: "page" | "popup" | "inline";
	title: string;
	icon: "reply" | "forward" | null;
	minimized: boolean;
	modalMode: boolean;
	onToggleMinimized: () => void;
	onToggleModal: () => void;
	onPopOut: () => void;
	onClose?: () => void;
};

/** Pop out and close for the reply docked in the reader; Zero's composer header is light, not a dark bar. */
function InlineControls({ onPopOut, onClose }: Pick<ComposeHeaderProps, "onPopOut" | "onClose">) {
	return (
		<div className="flex shrink-0 items-center gap-1">
			<Tooltip label="Pop out">
				<button
					type="button"
					onClick={onPopOut}
					aria-label="Pop out composer"
					className="rounded-md p-1.5 hover:bg-neutral-100 hover:text-neutral-900"
				>
					<SquareArrowOutUpRight className="h-4 w-4" />
				</button>
			</Tooltip>
			<Tooltip label="Close (Esc); the draft is kept">
				<button
					type="button"
					onClick={onClose}
					aria-label="Close composer"
					className="rounded-md p-1.5 hover:bg-neutral-100 hover:text-neutral-900"
				>
					<X className="h-4 w-4" />
				</button>
			</Tooltip>
		</div>
	);
}

function PopupControls({
	minimized,
	modalMode,
	onToggleMinimized,
	onToggleModal,
	onClose,
}: Pick<ComposeHeaderProps, "minimized" | "modalMode" | "onToggleMinimized" | "onToggleModal" | "onClose">) {
	const minimizeLabel = minimized ? "Restore composer" : "Minimize composer";
	const modalLabel = modalMode ? "Restore floating composer" : "Open composer as modal";
	return (
		<div className="flex shrink-0 items-center gap-3 text-neutral-300 dark:text-neutral-600">
			<button
				type="button"
				onClick={onToggleMinimized}
				aria-label={minimizeLabel}
				title={minimizeLabel}
				className="rounded p-1 hover:bg-neutral-700 dark:hover:bg-neutral-200 hover:text-white"
			>
				{minimized ? <ChevronUp className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
			</button>
			<button
				type="button"
				onClick={onToggleModal}
				aria-label={modalLabel}
				title={modalLabel}
				className="rounded p-1 dark:hover:bg-neutral-200 hover:bg-neutral-700 hover:text-white"
			>
				{modalMode ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
			</button>
			<button
				type="button"
				onClick={onClose}
				aria-label="Close composer"
				className="rounded p-1 hover:bg-neutral-700 dark:hover:bg-neutral-200 hover:text-white"
			>
				<X className="h-4 w-4" />
			</button>
		</div>
	);
}

/** The composer's title bar: a dark bar on the floating window and the page, a light row when docked inline. */
export function ComposeHeader(props: ComposeHeaderProps) {
	const { mode, title, icon } = props;
	const inline = mode === "inline";
	return (
		<div
			className={cn(
				"flex h-9 shrink-0 items-center justify-between px-4 text-sm font-medium",
				inline ? "border-b border-neutral-100 text-neutral-500" : "bg-neutral-800 text-white dark:bg-neutral-100",
			)}
		>
			<span className={cn("flex min-w-0 items-center gap-2 truncate", !inline && "dark:text-neutral-900")}>
				{icon === "reply" && <Reply className="h-3.5 w-3.5 text-neutral-300" />}
				{icon === "forward" && <Forward className="h-3.5 w-3.5 text-neutral-300" />}
				{title}
			</span>
			{inline && <InlineControls onPopOut={props.onPopOut} onClose={props.onClose} />}
			{mode === "popup" && <PopupControls {...props} />}
		</div>
	);
}
