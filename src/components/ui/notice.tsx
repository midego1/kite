import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CircleX, Info, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NoticeTone } from "./notice-types";
import { NOTICE_TONE_CLASS, noticeRole } from "./notice-utils";

const icons: Record<NoticeTone, LucideIcon> = {
	info: Info,
	success: CheckCircle2,
	warning: AlertTriangle,
	error: CircleX,
};

/**
 * An inline message on a page or in a card: blue for information, green for a success, amber for a warning and
 * red for an error. Errors announce themselves (`role="alert"`); the others are a status.
 */
export function Notice({
	tone = "info",
	title,
	children,
	actions,
	icon = true,
	className,
	...props
}: {
	tone?: NoticeTone;
	title?: ReactNode;
	children?: ReactNode;
	actions?: ReactNode;
	/** `false` hides the tone icon, for one-line notices inside a form. */
	icon?: boolean;
	className?: string;
	"data-testid"?: string;
}) {
	const Icon = icons[tone];
	return (
		<div
			role={noticeRole(tone)}
			className={cn("flex items-start gap-3 rounded-xl border px-4 py-3 text-sm", NOTICE_TONE_CLASS[tone], className)}
			{...props}
		>
			{icon && <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
			<div className="min-w-0 flex-1">
				{title && <p className="font-medium">{title}</p>}
				{children && <div className={cn(title && "mt-1", "[&_a]:underline [&_a]:underline-offset-2")}>{children}</div>}
			</div>
			{actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
		</div>
	);
}
