import { Menu, Paperclip, RotateCw, Search, Sparkles, SquarePen, X } from "lucide-react";
import { demoMailbox, demoSidebarCore, demoSidebarModules, demoViewTitles } from "./home-demo-data";
import { demoCounts, listMessages } from "./home-demo-state-utils";
import type { DemoFrameProps, DemoPartProps, DemoRowProps, DemoSidebarItem, DemoState } from "./home-demo-types";

/*
 * The sidebar, the message list and the toast of the demo, in the classes of the real sidebar and list
 * (src/components/messages/message-list-row.tsx). Every button carries `data-action`; the client demo handles
 * them with one delegated click handler, so these parts also render on the server without function props.
 */

export const FOCUS_RING =
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1";
export const PRIMARY_BUTTON = `rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 ${FOCUS_RING}`;
export const SECONDARY_BUTTON = `rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-800 hover:bg-neutral-100 ${FOCUS_RING}`;
export const GHOST_BUTTON = `rounded-lg px-2.5 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-100 ${FOCUS_RING}`;

function SidebarItem({ item, state, count }: { item: DemoSidebarItem; state: DemoState; count?: number }) {
	const Icon = item.icon;
	const active = state.view === item.view;
	return (
		<li>
			<button
				type="button"
				data-action="view"
				data-view={item.view}
				aria-current={active ? "page" : undefined}
				className={`flex h-9 w-full items-center justify-between rounded-lg px-3 text-sm ${FOCUS_RING} ${
					active ? "bg-neutral-100 font-medium text-neutral-900" : "text-neutral-600 hover:bg-neutral-100"
				}`}
			>
				<span className="flex items-center gap-3">
					<Icon className="h-4 w-4" aria-hidden="true" />
					{item.label}
				</span>
				{count ? <span className="text-xs text-neutral-500">{count}</span> : null}
			</button>
		</li>
	);
}

export function DemoSidebar({ state, appName }: DemoPartProps) {
	const counts = demoCounts(state);
	return (
		<aside
			aria-label="Folders"
			className={`${
				state.menuOpen
					? "absolute inset-y-0 left-0 z-20 flex w-64 shadow-2xl lg:static lg:w-auto lg:shadow-none"
					: "hidden lg:flex"
			} min-w-0 flex-col gap-1 overflow-y-auto border-r border-neutral-200 bg-[#f6f8fc] px-3 py-4`}
		>
			<div className="mb-3 flex items-center gap-2 px-1 text-neutral-600">
				<button
					type="button"
					data-action="toggleMenu"
					aria-label="Close menu"
					className={`flex h-7 w-7 items-center justify-center rounded-md lg:hidden ${FOCUS_RING}`}
				>
					<X className="h-4 w-4" aria-hidden="true" />
				</button>
				<Menu className="hidden h-4 w-4 lg:block" aria-hidden="true" />
				<span className="flex items-center gap-2 text-neutral-900">
					<img src="/kite.svg" alt="" width={20} height={20} />
					<span className="text-base font-bold tracking-tight">{appName}</span>
				</span>
			</div>
			<div className="mb-2 px-1">
				<p className="text-sm font-semibold text-neutral-900">{demoMailbox.name}</p>
				<p className="truncate text-xs text-neutral-500">{demoMailbox.address}</p>
			</div>
			<button
				type="button"
				data-action="reply"
				data-id="launch-plan"
				className={`mb-3 flex h-10 items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-white text-sm font-medium text-neutral-900 shadow-sm hover:bg-neutral-100 ${FOCUS_RING}`}
			>
				<SquarePen className="h-4 w-4" aria-hidden="true" />
				New email
			</button>
			<p className="px-3 pb-1 text-xs font-medium text-neutral-500">Core</p>
			<ul className="flex flex-col gap-1">
				{demoSidebarCore.map((item) => (
					<SidebarItem key={item.view} item={item} state={state} count={counts[item.view]} />
				))}
			</ul>
			<p className="px-3 pb-1 pt-3 text-xs font-medium text-neutral-500">Modules and folders</p>
			<ul className="flex flex-col gap-1">
				{demoSidebarModules.map((item) => (
					<SidebarItem key={item.view} item={item} state={state} count={counts[item.view]} />
				))}
			</ul>
		</aside>
	);
}

function UpdateRow({ appName }: { appName: string }) {
	return (
		<div className="flex items-center gap-3 border-b border-neutral-200 bg-[#eef3fb] px-4 py-2.5 text-sm">
			<img src="/kite.svg" alt="" width={20} height={20} />
			<span className="min-w-0 flex-1 truncate text-neutral-900">{appName} was updated</span>
			<button
				type="button"
				data-action="dismissUpdate"
				className={`inline-flex h-7 items-center gap-1.5 rounded-lg bg-blue-600 px-2.5 text-xs font-medium text-white hover:bg-blue-700 ${FOCUS_RING}`}
			>
				<RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
				Reload
			</button>
			<button
				type="button"
				data-action="dismissUpdate"
				aria-label="Dismiss"
				className={`flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 ${FOCUS_RING}`}
			>
				<X className="h-4 w-4" aria-hidden="true" />
			</button>
		</div>
	);
}

function DemoRow({ message, selected, screener }: DemoRowProps) {
	const Badge = message.badge?.icon;
	return (
		<li className={`flex items-stretch ${selected ? "bg-neutral-100" : ""}`}>
			<button
				type="button"
				data-action="open"
				data-id={message.id}
				aria-current={selected ? "true" : undefined}
				className={`flex min-w-0 flex-1 items-start gap-3 px-4 py-3 text-left hover:bg-neutral-100 ${FOCUS_RING} focus-visible:ring-inset`}
			>
				<span className="relative mt-0.5 h-9 w-9 shrink-0" aria-hidden="true">
					<span
						className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-medium ${message.from.avatarClassName}`}
					>
						{message.from.initial}
					</span>
					{message.unread && (
						<span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-blue-500 ring-2 ring-[var(--color-white)]" />
					)}
				</span>
				<span className="min-w-0 flex-1">
					<span className="flex items-baseline justify-between gap-2">
						<span
							className={`truncate text-sm ${message.unread ? "font-semibold text-neutral-900" : "text-neutral-800"}`}
						>
							{message.unread && <span className="sr-only">Unread </span>}
							{message.status === "sent" || message.status === "draft" ? `To ${message.to}` : message.from.name}
							{message.earlier && (
								<span className="ml-1.5 font-normal text-neutral-500">[{message.earlier.length + 1}]</span>
							)}
						</span>
						<span className="flex shrink-0 items-center gap-1.5 text-xs text-neutral-500">
							{message.attachments.length > 0 && <Paperclip className="h-3.5 w-3.5" aria-label="Has attachments" />}
							{Badge && (
								<Badge className={`h-3.5 w-3.5 ${message.badge?.className}`} aria-label={message.badge?.label} />
							)}
							{message.time}
						</span>
					</span>
					<span className="mt-0.5 flex items-center gap-2">
						<span
							className={`min-w-0 truncate text-sm ${message.unread ? "font-medium text-neutral-900" : "text-neutral-600"}`}
						>
							{message.subject}
						</span>
						{message.screening && !screener && (
							<span className="shrink-0 rounded-full border border-amber-300 bg-amber-50 px-2 py-px text-[11px] font-medium text-amber-800">
								New sender
							</span>
						)}
					</span>
				</span>
			</button>
			{screener && (
				<span className="flex shrink-0 flex-col justify-center gap-1 pr-3">
					<button type="button" data-action="approve" data-id={message.id} className={PRIMARY_BUTTON}>
						Approve
					</button>
					<button type="button" data-action="deny" data-id={message.id} className={SECONDARY_BUTTON}>
						Deny
					</button>
				</span>
			)}
		</li>
	);
}

export function DemoList({ state, live, appName, onSearch }: DemoFrameProps) {
	const rows = listMessages(state);
	const title = demoViewTitles[state.view];
	return (
		<section
			aria-label={title}
			className={`${state.mobilePane === "reader" ? "hidden md:flex" : "flex"} min-w-0 flex-col overflow-hidden border-r border-neutral-200 bg-white`}
		>
			<div className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 px-4">
				<span className="flex items-center gap-3 text-base font-semibold text-neutral-900">
					<button
						type="button"
						data-action="toggleMenu"
						aria-label="Open menu"
						className={`flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 lg:hidden ${FOCUS_RING}`}
					>
						<Menu className="h-4 w-4" aria-hidden="true" />
					</button>
					{title}
				</span>
				<button
					type="button"
					data-action="toggleChat"
					className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm text-neutral-600 hover:bg-neutral-100 ${FOCUS_RING}`}
				>
					<Sparkles className="h-4 w-4" aria-hidden="true" />
					{appName} AI
				</button>
			</div>
			<div className="shrink-0 px-4 py-3">
				<label className="flex h-10 items-center gap-3 rounded-lg border border-neutral-200 bg-[#f6f8fc] px-3 text-sm text-neutral-500 focus-within:border-blue-500">
					<Search className="h-4 w-4 shrink-0" aria-hidden="true" />
					<span className="sr-only">Search mail</span>
					<input
						type="search"
						placeholder="Search mail"
						value={state.search}
						readOnly={!live}
						onChange={onSearch ? (event) => onSearch(event.target.value) : undefined}
						className="min-w-0 flex-1 bg-transparent text-neutral-900 placeholder:text-neutral-500 focus:outline-none"
					/>
					<kbd className="rounded border border-neutral-200 px-1.5 text-[11px]">⌘K</kbd>
				</label>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{state.updateRow && state.view === "inbox" && <UpdateRow appName={appName} />}
				{rows.length === 0 ? (
					<p className="px-6 py-10 text-center text-sm text-neutral-500">
						{state.search ? `No mail matches "${state.search}".` : "Nothing here."}
					</p>
				) : (
					<ul aria-label={`${title} messages`} className="divide-y divide-neutral-100">
						{rows.map((message) => (
							<DemoRow
								key={message.id}
								message={message}
								selected={message.id === state.openId}
								screener={state.view === "screener"}
							/>
						))}
					</ul>
				)}
			</div>
		</section>
	);
}

export function DemoToast({ state }: DemoPartProps) {
	if (!state.toast) return null;
	return (
		<div
			role="status"
			className="absolute bottom-4 left-1/2 z-30 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg bg-neutral-900 px-4 py-2.5 text-sm text-white shadow-lg"
		>
			<span className="min-w-0">{state.toast.text}</span>
			{state.toast.undo && (
				<button
					type="button"
					data-action="undo"
					className={`shrink-0 font-semibold text-blue-400 underline-offset-4 hover:underline ${FOCUS_RING}`}
				>
					Undo
				</button>
			)}
			<button
				type="button"
				data-action="dismissToast"
				aria-label="Dismiss"
				className={`-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded ${FOCUS_RING}`}
			>
				<X className="h-3.5 w-3.5" aria-hidden="true" />
			</button>
		</div>
	);
}
