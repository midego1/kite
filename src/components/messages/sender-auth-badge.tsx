"use client";

import { AlertTriangle } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { WARNING_FILL_CLASS, WARNING_TEXT_CLASS } from "@/components/notice-styles";
import { useT } from "@/lib/i18n/use-t";
import { cn } from "@/lib/utils";
import type { SenderAuthWarning } from "./sender-auth-warning-types";

/**
 * The compact pill next to a sender's name, in the thread and the open message, for a message
 * `deriveSenderAuthWarning` found something to flag on. A `<span>`, not the `Badge` component
 * (which renders a `<div>`): this sits inside the sender line's `<p>`/`<span>`, where a block
 * element is invalid. `role="img"` gives the `aria-label` (the full explanation) an element
 * screen readers actually read, since a label on a role-less `<span>` is ignored; the tooltip
 * repeats it for sighted keyboard and mouse use. Where the badge sits inside a button (the thread
 * card that expands a message), pass `interactive={false}`: a focus stop nested in a button is
 * invalid, and the button's own name already includes the label.
 */
export function SenderAuthBadge({
	warning,
	className,
	interactive = true,
}: {
	warning: SenderAuthWarning | null;
	className?: string;
	interactive?: boolean;
}) {
	const t = useT();
	if (!warning) return null;
	const label = t("This message didn't fully pass sender authentication checks.");
	return (
		<Tooltip label={label} className="shrink-0">
			<span
				role="img"
				tabIndex={interactive ? 0 : undefined}
				aria-label={label}
				className={cn(
					"inline-flex items-center gap-1 rounded-md border border-transparent px-2 py-0.5 text-xs font-medium",
					WARNING_FILL_CLASS,
					WARNING_TEXT_CLASS,
					className,
				)}
				data-sender-auth-badge
			>
				<AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
				<span>{t("Unverified sender")}</span>
			</span>
		</Tooltip>
	);
}
