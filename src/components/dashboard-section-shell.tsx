"use client";

import type { ReactNode } from "react";
import { AuthGuard } from "@/components/auth/auth-guard";
import type { AuthGuardProps } from "@/components/auth/auth-guard-types";
import { ComposeProvider } from "@/components/compose/compose-context";
import { FloatingComposer } from "@/components/compose/floating-composer";
import { DashboardNav } from "@/components/dashboard-nav";
import { DashboardNotices } from "@/components/dashboard-notices";
import { MailboxProvider } from "@/components/mailbox-provider";
import { MailboxSelector } from "@/components/mailbox-selector";
import { ShortcutsProvider } from "@/components/shortcuts";
import { MobileMenuButton, SidebarAside } from "@/components/sidebar-aside";
import { SidebarFrame } from "@/components/sidebar-frame";
import { SidebarProvider } from "@/components/sidebar-state";
import { MAIN_CONTENT_ID, SkipToContent } from "@/components/skip-to-content";
import { RouteTitle } from "@/components/route-title";

type DashboardSectionShellProps = Omit<AuthGuardProps, "children" | "mode" | "allowAuthenticated"> & {
	children: ReactNode;
	/** The sidebar; the mail navigation when absent. */
	nav?: ReactNode;
};

/**
 * The frame of every page outside the mail views (Settings, Admin and the module pages), drawn like the inbox:
 * the same resizable sidebar (a sheet on phones), and the page as one rounded, bordered panel on the page
 * background. A page that draws its own panels marks its root with `data-page-panels` (as the Settings and Admin
 * layout does), and the frame then steps back like the inbox does for its list and reader.
 */
export function DashboardSectionShell({ children, nav, ...guard }: DashboardSectionShellProps) {
	return (
		<AuthGuard {...guard}>
			<SidebarProvider mobileOverlay>
				<MailboxProvider>
					<ComposeProvider>
						<ShortcutsProvider>
							<RouteTitle />
							<div className="h-dvh overflow-hidden bg-[#f6f8fc]">
								<SkipToContent />
								<SidebarFrame
									sidebar={
										<SidebarAside className="md:w-full">
											<div className="h-full min-h-0">
												{nav ?? (
													<DashboardNav
														accountMenu={<MailboxSelector placement="sidebar" />}
														notices={<DashboardNotices slot="sidebar" />}
													/>
												)}
											</div>
										</SidebarAside>
									}
								>
									<div className="flex h-full min-h-0 min-w-0 flex-col">
										{/* Phones only: the desktop keeps the account menu in the sidebar. */}
										<header className="flex h-14 w-full shrink-0 items-center gap-2 px-2 text-sm md:hidden">
											<MobileMenuButton />
											<span className="flex-1" />
											<MailboxSelector />
										</header>
										<DashboardNotices slot="page" />
										<main
											id={MAIN_CONTENT_ID}
											tabIndex={-1}
											className="page-flush min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain scrollbar-gutter-stable bg-white focus:outline-none max-md:rounded-t-xl md:my-2 md:mr-2 md:rounded-xl md:border md:border-neutral-200 md:shadow-xs md:has-[[data-page-panels]]:overflow-hidden md:has-[[data-page-panels]]:border-transparent md:has-[[data-page-panels]]:bg-transparent md:has-[[data-page-panels]]:shadow-none md:has-[[data-page-panels]]:[scrollbar-gutter:auto]"
										>
											{children}
										</main>
									</div>
								</SidebarFrame>
								<FloatingComposer />
							</div>
						</ShortcutsProvider>
					</ComposeProvider>
				</MailboxProvider>
			</SidebarProvider>
		</AuthGuard>
	);
}
