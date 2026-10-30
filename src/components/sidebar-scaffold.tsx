import type { SidebarScaffoldProps } from "./sidebar-state-types";
import { cn } from "@/lib/utils";
import { useBranding } from "./branding-provider";
import { useSidebar } from "./sidebar-state";

// Header and footer stay put; only the middle scrolls. The padding inside the scroller
// matches the mask's fade length, so nothing looks faded until content actually scrolls under it.
// A tall footer (notices, Settings, the version line) scrolls on its own past half the sidebar, so in a
// short window it can never push the menu out of sight or sit over it. The account block is the last item and
// stays pinned below the footer, so a tall footer can never scroll it away.
export function SidebarScaffold({ header, footer, account, children, className }: SidebarScaffoldProps) {
	const { minimal } = useSidebar();
	const { appName } = useBranding();
	return (
		<nav aria-label={appName} className={cn("flex h-full min-h-0 flex-col overflow-hidden", className)}>
			<div className="shrink-0 px-4 pt-4">{header}</div>
			<div
				className={cn(
					"flex min-h-0 flex-1 flex-col gap-px overflow-y-auto [&>*]:shrink-0 overscroll-contain py-3",
					minimal ? "px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : "pl-1 pr-4 [scrollbar-gutter:stable]",
					"[mask-image:linear-gradient(to_bottom,transparent,black_12px,black_calc(100%-12px),transparent)]",
				)}
			>
				{children}
			</div>
			{footer && (
				<div className="max-h-[50%] min-h-0 shrink-0 overflow-y-auto overscroll-contain px-4 pb-3">{footer}</div>
			)}
			{account && <div className={cn("shrink-0 pb-3", minimal ? "px-4" : "px-3")}>{account}</div>}
		</nav>
	);
}
