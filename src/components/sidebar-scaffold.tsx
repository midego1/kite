import { useRef } from "react";
import type { SidebarScaffoldProps } from "./sidebar-state-types";
import { cn } from "@/lib/utils";
import { useBranding } from "./branding-provider";
import { useSidebar } from "./sidebar-state";
import { useOverflowEdges } from "./use-overflowing";

// Header and footer stay put; only the middle scrolls, and an edge fades only while content continues past
// it, so the last item is never dimmed once scrolled into view. The padding inside the scroller matches the
// mask's fade length, so nothing looks faded until content scrolls under it.
// A tall footer (notices, Settings, the version line) scrolls on its own past 45% of the sidebar, so in a
// short window it can never push the menu out of sight or sit over it. The account block is the last item and
// stays pinned below the footer, so a tall footer can never scroll it away.
export function SidebarScaffold({ header, footer, account, children, className }: SidebarScaffoldProps) {
	const { minimal } = useSidebar();
	const { appName } = useBranding();
	const scroller = useRef<HTMLDivElement>(null);
	const edges = useOverflowEdges(scroller);
	return (
		<nav aria-label={appName} className={cn("flex h-full min-h-0 flex-col overflow-hidden", className)}>
			<div className="shrink-0 px-4 pt-4">{header}</div>
			<div
				ref={scroller}
				className={cn(
					"flex min-h-0 flex-1 flex-col gap-px overflow-y-auto [&>*]:shrink-0 overscroll-contain py-3",
					minimal ? "px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : "pl-1 pr-4 [scrollbar-gutter:stable]",
					// The fade marks content scrolling under an edge, so each edge shows it only while something is hidden there.
					edges.above &&
						edges.below &&
						"[mask-image:linear-gradient(to_bottom,transparent,black_12px,black_calc(100%-12px),transparent)]",
					edges.above && !edges.below && "[mask-image:linear-gradient(to_bottom,transparent,black_12px)]",
					!edges.above && edges.below && "[mask-image:linear-gradient(to_bottom,black_calc(100%-12px),transparent)]",
				)}
			>
				{children}
			</div>
			{footer && (
				<div className="max-h-[45%] min-h-0 shrink-0 overflow-y-auto overscroll-contain px-4 pb-3">{footer}</div>
			)}
			{account && <div className={cn("shrink-0 pb-3", minimal ? "px-4" : "px-3")}>{account}</div>}
		</nav>
	);
}
