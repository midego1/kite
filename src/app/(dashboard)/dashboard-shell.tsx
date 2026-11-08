"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AuthGuard } from "@/components/auth/auth-guard";
import { ComposeProvider } from "@/components/compose/compose-context";
import { FloatingComposer } from "@/components/compose/floating-composer";
import { MailSearchProvider } from "@/components/mail-search/mail-search-context";
import { MailboxProvider } from "@/components/mailbox-provider";
import { MailboxSelector } from "@/components/mailbox-selector";
import { LazyAgentPanel } from "@/components/agent/agent-panel-lazy";
import { ASSISTANT_PROMPT_EVENT, hasAssistantPrompt } from "@/components/agent/assistant-prompt-request";
import { consumeAssistantConversationParam } from "@/components/agent/assistant-conversation-request";
import { AssistantIconButton, AssistantNavItem } from "@/components/agent/assistant-nav-item";
import {
	AssistantDockedContext,
	AssistantOpenContext,
	AssistantToggleContext,
	type AssistantToggleState,
} from "@/components/agent/assistant-open-state";
import { DashboardNav } from "@/components/dashboard-nav";
import { SidebarProvider } from "@/components/sidebar-state";
import { SidebarAside, MobileMenuButton } from "@/components/sidebar-aside";
import { MobileTabBar } from "@/components/mobile-tab-bar";
import { MobileComposeFab } from "@/components/mobile-compose-fab";
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
import { AssistantCommand } from "./assistant-command";
import { FloatingAssistant } from "./floating-assistant-window";
import { RouteTitle } from "@/components/route-title";
import { BootStep } from "@/components/boot-step";

type DockedAssistantProps = {
	visible: boolean;
	fullSize: boolean;
	width: number;
	resizing: boolean;
	/** Whether the panel's code is loaded; it stays mounted once it has been shown. */
	loaded: boolean;
	onResizeStart: () => void;
	onResize: (delta: number) => void;
	onResizeEnd: () => void;
	onToggleFullSize: () => void;
	onClose: () => void;
};

/** The assistant beside the page: a column at the end of the line that resizes, or the whole width when it is full size. */
function DockedAssistant({
	visible,
	fullSize,
	width,
	resizing,
	loaded,
	onResizeStart,
	onResize,
	onResizeEnd,
	onToggleFullSize,
	onClose,
}: DockedAssistantProps) {
	return (
		<aside
			className={clsx(
				// Beside the page the panel sits where the list and the reader do: the page's 8px inset,
				// plus the 1px their transparent border adds while the split view is showing.
				fullSize ? "ps-0 pb-2" : "ps-2 md:py-2 md:group-has-[[data-reading-pane]]/page:py-[9px]",
				"relative min-h-0 min-w-0 shrink-0 overflow-hidden pe-2 max-md:p-0",
				!resizing && "transition-[width] duration-300 ease-in-out motion-reduce:transition-none",
				visible ? "" : "opacity-0",
			)}
			style={{ width: visible ? (fullSize ? "100%" : `min(${width}px, 100%)`) : "0px" }}
			aria-hidden={!visible}
			inert={!visible}
		>
			{visible && !fullSize && (
				<div className="absolute inset-y-0 start-1 hidden w-0 md:block">
					<ResizeHandle
						label="Resize assistant"
						onResizeStart={onResizeStart}
						onResize={onResize}
						onResizeEnd={onResizeEnd}
					/>
				</div>
			)}
			{loaded && (
				<LazyAgentPanel
					open={visible}
					fullSize={fullSize}
					docked={!fullSize}
					onToggleFullSize={onToggleFullSize}
					onClose={onClose}
				/>
			)}
		</aside>
	);
}

/**
 * The mail shell: the resizable sidebar with the mail menu, the page beside it as one bordered panel (or, when the
 * page marks its root with `data-reading-pane` or `data-page-panels`, the page's own panels on the page
 * background), the assistant docked at the right or floating, and the composer. The mail views, Calendar and
 * Booking all live in it, so every page keeps the same frame.
 */
export function DashboardShell({ children }: { children: React.ReactNode }) {
	const { assistantOpen, setAssistantOpen, assistantFullSize, setAssistantFullSize } = useDashboardState();
	const assistantEnabled = useAssistantAvailability();
	const assistantVisible = assistantEnabled === true && assistantOpen;
	useAppBadge();
	// An assistant-by-email reply's deep link (`?assistant=<conversationId>`); the panel itself takes the id once open.
	useEffect(() => {
		if (consumeAssistantConversationParam()) setAssistantOpen(true);
	}, [setAssistantOpen]);
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

	// Ask AI (the overview's Why?) leaves a question for the assistant: open it so the panel can take the question.
	useEffect(() => {
		if (assistantEnabled !== true) return;
		const openForRequest = () => {
			if (hasAssistantPrompt()) setAssistantOpen(true);
		};
		openForRequest();
		window.addEventListener(ASSISTANT_PROMPT_EVENT, openForRequest);
		return () => window.removeEventListener(ASSISTANT_PROMPT_EVENT, openForRequest);
	}, [assistantEnabled, setAssistantOpen]);

	const toggleAssistant = () => {
		setAssistantOpen((current) => !current);
		setAssistantFullSize(false);
	};
	const assistantToggleState: AssistantToggleState = {
		available: assistantEnabled === true,
		open: assistantOpen,
		toggle: toggleAssistant,
	};

	return (
		<AuthGuard>
			<SidebarProvider mobileOverlay>
				<MailboxProvider>
					<ComposeProvider>
						<MailSearchProvider>
							<ShortcutsProvider>
								{assistantEnabled === true && <AssistantCommand toggle={toggleAssistant} />}
								<RouteTitle />
								{/* viewport-fit=cover (src/app/layout.tsx) makes env(safe-area-inset-*) resolve app-wide, not just
							at the bottom the tab bar and the compose button already account for: a landscape phone or a
							device with rounded corners can have a real left/right inset too. */}
								<div className="h-dvh overflow-hidden bg-[#f6f8fc] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
									<SkipToContent />
									<SidebarFrame
										sidebar={
											<SidebarAside className="md:w-full">
												<div className="h-full min-h-0">
													<BootStep name="sidebar" />
													<DashboardNav
														assistantToggle={<AssistantNavItem assistant={assistantToggleState} />}
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
												<AssistantIconButton assistant={assistantToggleState} />
												<MailboxSelector />
											</header>
											<DashboardNotices slot="page" />
											<div className="group/page flex min-h-0 min-w-0 flex-1 overflow-hidden">
												<AssistantOpenContext.Provider value={assistantVisible && assistantLayout === "sidebar"}>
													<main
														id={MAIN_CONTENT_ID}
														tabIndex={-1}
														// One bordered panel for the page; the split mail views (`data-reading-pane`) and the pages with panels of
														// their own (`data-page-panels`: Calendar, Booking) draw them on the page background, and then the page
														// is a flex column that never scrolls: the list and the reader scroll inside their panels.
														className="focus:outline-none min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain scrollbar-gutter-stable bg-white md:mt-2 md:mb-2 md:rounded-xl md:border md:border-neutral-200 md:shadow-xs has-[[data-reading-pane]]:flex has-[[data-reading-pane]]:flex-col has-[[data-reading-pane]]:overflow-hidden has-[[data-reading-pane]]:border-transparent has-[[data-reading-pane]]:bg-transparent has-[[data-reading-pane]]:shadow-none has-[[data-reading-pane]]:[scrollbar-gutter:auto] md:has-[[data-page-panels]]:overflow-hidden md:has-[[data-page-panels]]:border-transparent md:has-[[data-page-panels]]:bg-transparent md:has-[[data-page-panels]]:shadow-none md:has-[[data-page-panels]]:[scrollbar-gutter:auto] has-[[data-panel-header]]:[scrollbar-gutter:auto]"
														aria-hidden={assistantVisible && assistantFullSize && assistantLayout === "sidebar"}
														inert={assistantVisible && assistantFullSize && assistantLayout === "sidebar"}
													>
														<AssistantToggleContext.Provider value={assistantToggleState}>
															<BootStep name="page" />
															{children}
														</AssistantToggleContext.Provider>
													</main>
												</AssistantOpenContext.Provider>
												{assistantLayout === "sidebar" && (
													<DockedAssistant
														visible={assistantVisible}
														fullSize={assistantFullSize}
														width={assistantWidth}
														resizing={resizingAssistant}
														loaded={assistantEnabled === true && assistantLoaded}
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
														onToggleFullSize={() => setAssistantFullSize((current) => !current)}
														onClose={() => {
															setAssistantOpen(false);
															setAssistantFullSize(false);
														}}
													/>
												)}
											</div>
											<MobileTabBar />
											<MobileComposeFab />
										</div>
									</SidebarFrame>
									{assistantLayout === "floating" && assistantEnabled === true && (
										<FloatingAssistant
											open={assistantOpen}
											fullSize={assistantFullSize}
											onToggle={toggleAssistant}
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
										<BootStep name="composer" />
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
