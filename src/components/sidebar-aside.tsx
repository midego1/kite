"use client";

import { Menu } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetTitle } from "./ui/sheet";
import { useSidebar } from "./sidebar-state";

// The sheet opens from the top bar's menu button, outside its Root, so focus goes back there on close.
const menuButton = () => document.querySelector<HTMLElement>("[data-mobile-menu]");

/**
 * The sidebar column; on phones a Sheet that slides in from the left. The sheet stays in place in the DOM
 * (no portal), so the sidebar keeps its position in the page's reading order.
 */
export function SidebarAside({ children, className }: { children: ReactNode; className?: string }) {
	const { mobile, mobileOpen, setMobileOpen } = useSidebar();

	if (mobile)
		return (
			<Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
				<SheetContent
					portal={false}
					returnFocusTo={menuButton}
					side="left"
					closeLabel="Close menu"
					aria-describedby={undefined}
					className="bg-[#f6f8fc]"
				>
					<SheetTitle className="sr-only">Menu</SheetTitle>
					<aside className={cn("h-full min-h-0 min-w-0", className)}>{children}</aside>
				</SheetContent>
			</Sheet>
		);

	return (
		<aside className={cn("relative z-30 h-full min-h-0 min-w-0 bg-[#f6f8fc] md:w-[var(--sidebar-width)]", className)}>
			{children}
		</aside>
	);
}

export function MobileMenuButton({ className }: { className?: string }) {
	const { mobile, mobileOpen, toggle } = useSidebar();
	if (!mobile) return null;
	return (
		<button
			type="button"
			data-mobile-menu
			onClick={toggle}
			aria-label="Open menu"
			aria-expanded={mobileOpen}
			className={cn(
				"flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-200 md:hidden",
				className,
			)}
		>
			<Menu size={20} />
		</button>
	);
}
