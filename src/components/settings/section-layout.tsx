import type { ReactNode } from "react";
import type { NavMode } from "./section-nav-types";
import { SectionNav } from "./section-nav";

/** The section menu beside the page content, shared by the Settings and Admin pages. */
export function SectionLayout({ mode, children }: { mode: NavMode; children: ReactNode }) {
	return (
		<div className="flex flex-col justify-end gap-4 min-h-[calc(100dvh-4rem)] bg-inherit md:flex-row md:justify-start">
			<SectionNav mode={mode} />
			<div className="min-w-0 flex-1 pt-4 max-md:px-6 max-md:pb-36 md:px-8">
				<div className="mx-auto w-full max-w-3xl">{children}</div>
			</div>
		</div>
	);
}
