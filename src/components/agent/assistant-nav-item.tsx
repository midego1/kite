"use client";

import clsx from "clsx";
import { Sparkles } from "lucide-react";
import { useSidebar } from "@/components/sidebar-state";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { preloadAgentPanel } from "./agent-panel-lazy";
import type { AssistantToggleState } from "./assistant-open-state";

/**
 * The Assistant item in the sidebar footer. In the collapsed icon rail it is an icon with a tooltip, like the
 * rail's other items, so the assistant stays reachable from every list view; absent while the assistant is off.
 */
export function AssistantNavItem({ assistant }: { assistant: AssistantToggleState }) {
	const { minimal } = useSidebar();
	if (!assistant.available) return null;
	const label = assistant.open ? "Close email assistant" : "Open email assistant";
	const button = (
		<Button
			type="button"
			variant="ghost"
			size="sm"
			className={clsx(
				assistant.open ? "bg-blue-50 text-blue-700" : "text-neutral-600",
				minimal
					? "mx-auto h-9 w-10 justify-center rounded-full px-0"
					: "h-9 w-full justify-start gap-3 rounded-lg px-3 text-sm font-normal",
			)}
			onPointerEnter={() => void preloadAgentPanel().catch(() => undefined)}
			onClick={assistant.toggle}
			aria-label={label}
			aria-expanded={assistant.open}
			aria-controls="email-assistant-panel"
		>
			<Sparkles className="h-4 w-4" />
			{!minimal && "Assistant"}
		</Button>
	);
	return minimal ? (
		<Tooltip label={label} placement="right">
			{button}
		</Tooltip>
	) : (
		button
	);
}

/** The phone header's assistant button; absent while the assistant is off. */
export function AssistantIconButton({ assistant }: { assistant: AssistantToggleState }) {
	if (!assistant.available) return null;
	return (
		<Button
			type="button"
			variant="ghost"
			size="sm"
			className={assistant.open ? "bg-blue-50 text-blue-700" : "text-neutral-600"}
			onPointerEnter={() => void preloadAgentPanel().catch(() => undefined)}
			onClick={assistant.toggle}
			aria-label={assistant.open ? "Close email assistant" : "Open email assistant"}
			aria-expanded={assistant.open}
			aria-controls="email-assistant-panel"
		>
			<Sparkles className="h-5 w-5" />
		</Button>
	);
}
