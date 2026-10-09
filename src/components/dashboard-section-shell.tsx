"use client";

import type { ReactNode } from "react";
import { AuthGuard } from "@/components/auth/auth-guard";
import type { AuthGuardProps } from "@/components/auth/auth-guard-types";
import { ComposeProvider } from "@/components/compose/compose-context";
import { FloatingComposer } from "@/components/compose/floating-composer";
import { DashboardNav } from "@/components/dashboard-nav";
import { PageSearchInput } from "@/components/mail-search/page-search-input";
import { MailboxProvider } from "@/components/mailbox-provider";
import { MailboxSelector } from "@/components/mailbox-selector";
import { ShortcutsProvider } from "@/components/shortcuts";
import { MobileMenuButton, SidebarAside } from "@/components/sidebar-aside";
import { SidebarProvider } from "@/components/sidebar-state";

type DashboardSectionShellProps = Omit<AuthGuardProps, "children" | "mode" | "allowAuthenticated"> & {
	children: ReactNode;
};

/** The mail sidebar and top bar around the Settings and Admin pages. */
export function DashboardSectionShell({ children, ...guard }: DashboardSectionShellProps) {
	return (
		<AuthGuard {...guard}>
			<SidebarProvider mobileOverlay>
				<MailboxProvider>
					<ComposeProvider>
						<ShortcutsProvider>
							<div
								className="grid h-[100dvh] grid-cols-[minmax(0,1fr)] md:grid-cols-[var(--sidebar-width)_minmax(0,1fr)] overflow-hidden bg-[#f6f8fc] transition-[grid-template-columns]"
								style={{ transitionDuration: "var(--sidebar-transition-duration)" }}
							>
								<SidebarAside>
									<DashboardNav />
								</SidebarAside>
								<div className="flex min-h-0 min-w-0 flex-col">
									<header className="flex h-16 w-full shrink-0 items-center gap-4 pr-4 text-sm">
										<MobileMenuButton className="ml-2" />
										<PageSearchInput />
										<MailboxSelector />
									</header>
									<main className="page-flush min-h-0 flex-1 overflow-y-auto max-md:rounded-t-3xl max-md:bg-white overscroll-contain scrollbar-gutter-stable">
										{children}
									</main>
								</div>
								<FloatingComposer />
							</div>
						</ShortcutsProvider>
					</ComposeProvider>
				</MailboxProvider>
			</SidebarProvider>
		</AuthGuard>
	);
}
