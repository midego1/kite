import type { ComponentType, ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CircleX, Info, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NoticeTone } from "./notice-types";
import { noticeClass, noticeRole } from "./notice-utils";

const icons: Record<NoticeTone, LucideIcon> = {
	info: Info,
	success: CheckCircle2,
	warning: AlertTriangle,
	error: CircleX,
};

/**
 * An inline message on a page, in a card or in the sidebar: blue for information, green for a success, amber for
 * a warning and red for an error. Errors announce themselves (`role="alert"`); the others are a status, unless
 * the caller names the box as a landmark (`role="region"` with an `aria-label`, as the sidebar banners do) or
 * asks for no role at all (a note inside a dialog).
 * `compact` is the sidebar size: smaller type, tighter padding and the smaller radius.
 */
export function Notice({
	tone = "info",
	title,
	children,
	actions,
	icon = true,
	compact = false,
	tooltip,
	role,
	className,
	...props
}: {
	tone?: NoticeTone;
	title?: ReactNode;
	children?: ReactNode;
	actions?: ReactNode;
	/** `false` hides the tone icon, for one-line notices inside a form; an icon component replaces the tone's own. */
	icon?: boolean | ComponentType<{ className?: string; "aria-hidden"?: "true" }>;
	compact?: boolean;
	/** The HTML `title`, for the full list a truncated title stands for. */
	tooltip?: string;
	/** `"none"` for a plain note inside a dialog, which must not become a live region of its own. */
	role?: "region" | "status" | "alert" | "none";
	className?: string;
	"aria-label"?: string;
	"data-testid"?: string;
}) {
	const Icon = typeof icon === "boolean" ? icons[tone] : icon;
	return (
		<div
			role={role === "none" ? undefined : (role ?? noticeRole(tone))}
			title={tooltip}
			className={cn("flex items-start", noticeClass(tone, compact), className)}
			{...props}
		>
			{icon && <Icon className={cn("shrink-0", compact ? "mt-px h-3.5 w-3.5" : "mt-0.5 h-4 w-4")} aria-hidden="true" />}
			<div className="min-w-0 flex-1">
				{title && <p className={cn("font-medium", compact && "truncate")}>{title}</p>}
				{children && (
					<div className={cn(title && (compact ? "mt-0.5" : "mt-1"), "[&_a]:underline [&_a]:underline-offset-2")}>
						{children}
					</div>
				)}
			</div>
			{actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
		</div>
	);
}
