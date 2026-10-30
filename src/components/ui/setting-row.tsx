import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One setting: its name and a line of help on the left, the control (a switch, select or button) on the right.
 * Rows stack inside a card separated by rules (`SettingRows`); `filled` draws one row on the muted fill instead.
 */
export function SettingRow({
	title,
	description,
	htmlFor,
	children,
	filled = false,
	className,
}: {
	title: ReactNode;
	description?: ReactNode;
	/** The control's id, so clicking the name focuses it. */
	htmlFor?: string;
	children?: ReactNode;
	filled?: boolean;
	className?: string;
}) {
	const Title = htmlFor ? "label" : "p";
	return (
		<div
			className={cn(
				"flex items-center justify-between gap-4",
				filled ? "rounded-lg bg-neutral-50 p-4" : "py-4 first:pt-0 last:pb-0",
				className,
			)}
		>
			<div className="min-w-0">
				<Title htmlFor={htmlFor} className="block text-sm font-medium text-neutral-900">
					{title}
				</Title>
				{description && <p className="mt-0.5 text-sm text-neutral-500">{description}</p>}
			</div>
			{children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
		</div>
	);
}

/** Setting rows separated by rules. */
export function SettingRows({ children, className }: { children: ReactNode; className?: string }) {
	return <div className={cn("divide-y divide-neutral-200", className)}>{children}</div>;
}
