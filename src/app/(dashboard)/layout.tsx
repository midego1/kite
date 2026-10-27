"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { AuthGuard } from "@/components/auth/auth-guard";
import { ComposeProvider } from "@/components/compose/compose-context";
import { FloatingComposer } from "@/components/compose/floating-composer";
import { MailSearchProvider } from "@/components/mail-search/mail-search-context";
import { MailboxProvider } from "@/components/mailbox-provider";
import { MailboxSelector } from "@/components/mailbox-selector";
import { LazyAgentPanel, preloadAgentPanel } from "@/components/agent/agent-panel-lazy";
import { AssistantDockedContext, AssistantOpenContext } from "@/components/agent/assistant-open-state";
import { Button } from "@/components/ui/button";
import { DashboardNav } from "@/components/dashboard-nav";
import { SidebarProvider } from "@/components/sidebar-state";
import { SidebarAside, MobileMenuButton } from "@/components/sidebar-aside";
import { SidebarFrame } from "@/components/sidebar-frame";
import { DashboardNotices } from "@/components/dashboard-notices";
import { ShortcutsProvider } from "@/components/shortcuts";
import { MAIN_CONTENT_ID, SkipToContent } from "@/components/skip-to-content";
import clsx from "clsx";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { readInitialColumnWidth, saveColumnWidth } from "@/components/column-width-preferences";
import { ASSISTANT_LAYOUT_PREFERENCE } from "@/components/appearance-preferences";
import { useAppearancePreference } from "@/components/use-appearance-preference";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useAppBadge } from "@/hooks/use-app-badge";

const DEFAULT_ASSISTANT_WIDTH = 390;
const MIN_ASSISTANT_WIDTH = 320;
const MAX_ASSISTANT_WIDTH = 900;

// Leaves room for the email list so the assistant can never squeeze it away.
function clampAssistantWidth(width: number) {
	const roomLeft = typeof window === "undefined" ? MAX_ASSISTANT_WIDTH : window.innerWidth - 560;
	return Math.round(Math.max(MIN_ASSISTANT_WIDTH, Math.min(MAX_ASSISTANT_WIDTH, roomLeft, width)));
}
import { useDashboardState, useLatch } from "./dashboard-state";
import { useAssistantAvailability } from "./use-assistant-availability";
import { FloatingAssistant } from "./floating-assistant-window";
import { RouteTitle } from "@/components/route-title";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
	const { assistantOpen, setAssistantOpen, assistantFullSize, setAssistantFullSize } = useDashboardState();
	const assistantEnabled = useAssistantAvailability();
	const assistantVisible = assistantEnabled === true && assistantOpen;
	useAppBadge();
	const assistantLoaded = useLatch(assistantVisible);
	const [assistantLayout] = useAppearancePreference(ASSISTANT_LAYOUT_PREFERENCE);
	const userId = useCurrentUser()?.id ?? null;
	const [assistantWidth, setAssistantWidthState] = useState(DEFAULT_ASSISTANT_WIDTH);
	const assistantWidthRef = useRef(DEFAULT_ASSISTANT_WIDTH);
	const assistantResizeStart = useRef(DEFAULT_ASSISTANT_WIDTH);
	const [resizingAssistant, setResizingAssistant] = useState(false);
	const setAssistantWidth = (width: number) => {
		assistantWidthRef.current = width;
		setAssistantWidthState(width);
	};

	useLayoutEffect(() => {
		const width = clampAssistantWidth(
			readInitialColumnWidth("assistant", DEFAULT_ASSISTANT_WIDTH, MIN_ASSISTANT_WIDTH, MAX_ASSISTANT_WIDTH),
		);
		assistantWidthRef.current = width;
		// The saved width lives in localStorage, which only exists in the browser.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		setAssistantWidthState(width);
	}, []);

	useEffect(() => {
		if (assistantEnabled === false && (assistantOpen || assistantFullSize)) {
			setAssistantOpen(false);
			setAssistantFullSize(false);
		}
	}, [assistantEnabled, assistantOpen, assistantFullSize, setAssistantOpen, setAssistantFullSize]);

	const assistantToggle = (variant: "icon" | "nav") =>
		assistantEnabled ? (
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className={clsx(
					assistantOpen ? "bg-blue-50 text-blue-700" : "text-neutral-600",
					variant === "nav" && "h-9 w-full justify-start gap-3 rounded-lg px-3 text-sm font-normal",
				)}
				onPointerEnter={() => void preloadAgentPanel().catch(() => undefined)}
				onClick={() => {
					setAssistantOpen((current) => !current);
					setAssistantFullSize(false);
				}}
				aria-label={assistantOpen ? "Close email assistant" : "Open email assistant"}
				aria-expanded={assistantOpen}
				aria-controls="email-assistant-panel"
			>
				<Sparkles className={variant === "nav" ? "h-4 w-4" : "h-5 w-5"} />
				{variant === "nav" && "Assistant"}
			</Button>
		) : null;

	return (
		<AuthGuard>
			<SidebarProvider mobileOverlay>
				<MailboxProvider>
					<ComposeProvider>
						<MailSearchProvider>
							<ShortcutsProvider>
								<RouteTitle />
								<div className="h-dvh overflow-hidden bg-[#f6f8fc]">
									<SkipToContent />
									<SidebarFrame
										sidebar={
											<SidebarAside className="md:w-full">
												<div className="h-full">
													<DashboardNav
														assistantToggle={assistantToggle("nav")}
														accountMenu={<MailboxSelector placement="sidebar" />}
														notices={<DashboardNotices slot="sidebar" />}
													/>
												</div>
											</SidebarAside>
										}
									>
										<div className="flex h-full min-h-0 min-w-0 flex-col">
											{/* Phones only: the desktop keeps search in the list panel and the rest in the sidebar. */}
											<header className="flex h-14 w-full shrink-0 items-center gap-2 px-2 text-sm md:hidden">
												<MobileMenuButton />
												<span className="flex-1" />
												{assistantToggle("icon")}
												<MailboxSelector />
											</header>
											<DashboardNotices slot="page" />
											<div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
												<AssistantOpenContext.Provider value={assistantVisible && assistantLayout === "sidebar"}>
													<main
														id={MAIN_CONTENT_ID}
														tabIndex={-1}
														// One bordered panel for the page; the split mail views draw their own panels on the page background.
														className="focus:outline-none min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain scrollbar-gutter-stable bg-white md:mt-2 md:mb-2 md:rounded-xl md:border md:border-neutral-200 md:shadow-xs has-[[data-reading-pane]]:border-transparent has-[[data-reading-pane]]:bg-transparent has-[[data-reading-pane]]:shadow-none has-[[data-reading-pane]]:[scrollbar-gutter:auto]"
														aria-hidden={assistantVisible && assistantFullSize && assistantLayout === "sidebar"}
														inert={assistantVisible && assistantFullSize && assistantLayout === "sidebar"}
													>
														{children}
													</main>
												</AssistantOpenContext.Provider>
												{assistantLayout === "sidebar" && (
													<aside
														className={clsx(
															assistantFullSize ? "pl-0" : "pl-4",
															"relative min-h-0 min-w-0 shrink-0 overflow-hidden pr-2 pb-2 max-md:p-0",
															!resizingAssistant &&
																"transition-[width] duration-300 ease-in-out motion-reduce:transition-none",
															assistantVisible ? "" : "opacity-0",
														)}
														style={{
															width: assistantVisible
																? assistantFullSize
																	? "100%"
																	: `min(${assistantWidth}px, 100%)`
																: "0px",
														}}
														aria-hidden={!assistantVisible}
														inert={!assistantVisible}
													>
														{assistantVisible && !assistantFullSize && (
															<div className="absolute inset-y-0 left-2 hidden w-0 md:block">
																<ResizeHandle
																	label="Resize assistant"
																	onResizeStart={() => {
																		assistantResizeStart.current = assistantWidth;
																		setResizingAssistant(true);
																	}}
																	onResize={(delta) =>
																		setAssistantWidth(clampAssistantWidth(assistantResizeStart.current - delta))
																	}
																	onResizeEnd={() => {
																		setResizingAssistant(false);
																		saveColumnWidth(userId, "assistant", assistantWidthRef.current);
																	}}
																/>
															</div>
														)}
														{assistantEnabled && assistantLoaded && (
															<LazyAgentPanel
																open={assistantVisible}
																fullSize={assistantFullSize}
																onToggleFullSize={() => setAssistantFullSize((current) => !current)}
																onClose={() => {
																	setAssistantOpen(false);
																	setAssistantFullSize(false);
																}}
															/>
														)}
													</aside>
												)}
											</div>
										</div>
									</SidebarFrame>
									{assistantLayout === "floating" && assistantEnabled === true && (
										<FloatingAssistant
											open={assistantOpen}
											fullSize={assistantFullSize}
											onToggle={() => {
												setAssistantOpen((current) => !current);
												setAssistantFullSize(false);
											}}
											onToggleFullSize={() => setAssistantFullSize((current) => !current)}
											onClose={() => {
												setAssistantOpen(false);
												setAssistantFullSize(false);
											}}
										/>
									)}
									<AssistantDockedContext.Provider
										value={assistantLayout === "floating" && assistantVisible && !assistantFullSize}
									>
										<FloatingComposer />
									</AssistantDockedContext.Provider>
								</div>
							</ShortcutsProvider>
						</MailSearchProvider>
					</ComposeProvider>
				</MailboxProvider>
			</SidebarProvider>
		</AuthGuard>
	);
}
