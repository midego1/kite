import Link from "next/link";
import type { ReactNode } from "react";

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
		<section aria-label={title} data-testid={testId} className="rounded-3xl bg-[#f6f8fc] px-5 py-4">
			<div className="mb-2 flex items-center justify-between gap-3">
				<h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-neutral-500">{title}</h3>
				{action && (
					<Link href={action.href} className="text-xs font-medium text-blue-700 hover:underline">
						{action.label}
					</Link>
				)}
			</div>
			{children}
		</section>
	);
}
