"use client";

import clsx from "clsx";
import { Sparkles } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { preloadAgentPanel } from "./agent-panel-lazy";
import { useAssistantToggle } from "./assistant-open-state";

/**
 * The Kite AI button in the top right of the list header and the reader toolbar, where Zero keeps it. It
 * toggles the same panel as the sidebar item and the phone header, and is absent while the assistant is off.
 * Phones have their own button in the header, so this one starts at `md`.
 */
export function AssistantButton({ testId, showLabel = false }: { testId: string; showLabel?: boolean }) {
	const assistant = useAssistantToggle();
	if (!assistant?.available) return null;
	const label = assistant.open ? "Close Kite AI" : "Open Kite AI";
	return (
		<Tooltip label={`${label} (.)`} className="max-md:hidden">
			<button
				type="button"
				data-testid={testId}
				aria-label={label}
				aria-expanded={assistant.open}
				aria-controls="email-assistant-panel"
				onPointerEnter={() => void preloadAgentPanel().catch(() => undefined)}
				onClick={assistant.toggle}
				className={clsx(
					"flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400",
					showLabel ? "px-2" : "w-8",
					assistant.open ? "bg-blue-50 text-blue-700" : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900",
				)}
			>
				<Sparkles className="h-4 w-4" aria-hidden="true" />
				{showLabel && <span>Kite AI</span>}
			</button>
		</Tooltip>
	);
}
