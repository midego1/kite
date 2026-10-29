"use client";

import clsx from "clsx";
import { CalendarClock, CircleAlert, Loader2 } from "lucide-react";
import type { Message } from "@/hooks/types";
import { getMessageSendLabel } from "./send-state-utils";

const ICONS = { sending: Loader2, scheduled: CalendarClock, failed: CircleAlert } as const;

/** "Scheduled · Oct 30, 9:00 AM", "Sending…" or "Failed to send" on a Sent row that has not gone out. */
export function SendStateBadge({ message }: { message: Pick<Message, "sendState" | "createdAt"> }) {
	const label = getMessageSendLabel(message);
	if (!label) return null;
	const Icon = ICONS[label.kind];
	return (
		<span
			data-send-state={label.kind}
			className={clsx(
				"relative inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
				label.kind === "failed" ? "bg-red-50 text-red-700" : "bg-blue-50 text-blue-700",
			)}
		>
			<Icon aria-hidden="true" className="h-3 w-3" />
			{label.text}
		</span>
	);
}
