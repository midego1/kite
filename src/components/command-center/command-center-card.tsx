import Link from "next/link";
import type { ReactNode } from "react";

/** The surface the cards, chips and quick actions share: one step up from the pane, a hairline and a soft lift. */
export const COMMAND_CENTER_SURFACE_CLASS = "border border-cc-border bg-cc-surface shadow-(--cc-elevation)";

/** One card of the command center: a small uppercase title, an optional link at the right, and its content. */
export function CommandCenterCard({
	title,
	action,
	children,
	testId,
}: {
	title: string;
	action?: { label: string; href: string };
	children: ReactNode;
	testId?: string;
}) {
	return (
		<section
			aria-label={title}
			data-testid={testId}
			className={`rounded-2xl bg-(image:--cc-glow) px-5 py-4 ${COMMAND_CENTER_SURFACE_CLASS}`}
		>
			<div className="mb-2 flex items-center justify-between gap-3">
				<h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-cc-label">{title}</h3>
				{action && (
					<Link href={action.href} className="text-xs font-medium text-cc-accent hover:underline">
						{action.label}
					</Link>
				)}
			</div>
			{children}
		</section>
	);
}
