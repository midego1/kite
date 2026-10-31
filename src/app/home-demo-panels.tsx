import {
	CalendarDays,
	FileText,
	Folder,
	HardDrive,
	Image as ImageIcon,
	Menu,
	Receipt,
	Send,
	Sparkles,
	X,
} from "lucide-react";
import { demoViewTitles } from "./home-demo-data";
import { suggestedMessages } from "./home-demo-state-utils";
import { FOCUS_RING } from "./home-demo-parts";
import type {
	DemoFrameProps,
	DemoMessage,
	DemoPanelTeaserProps,
	DemoPartProps,
	DemoSuggestionKind,
} from "./home-demo-types";

/* The For you page, the glimpses of Calendar, Drive and Subscriptions, and the assistant chat of the demo. */

const GROUPS: { kind: DemoSuggestionKind; title: string }[] = [
	{ kind: "reply", title: "Replies" },
	{ kind: "invite", title: "Invitations" },
	{ kind: "subscription", title: "Subscriptions" },
];

function PanelHeader({ title, appName }: { title: string; appName: string }) {
	return (
		<div className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 px-4 text-base font-semibold text-neutral-900">
			<span className="flex items-center gap-3">
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
				className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-normal text-neutral-600 hover:bg-neutral-100 ${FOCUS_RING}`}
			>
				<Sparkles className="h-4 w-4" aria-hidden="true" />
				{appName} AI
			</button>
		</div>
	);
}

function ForYouCard({ message }: { message: DemoMessage }) {
	const suggestion = message.suggestion!;
	return (
		<li className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
			<p className="flex items-center gap-2 text-xs text-neutral-500">
				<span
					className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${message.from.avatarClassName}`}
				>
					{message.from.initial}
				</span>
				{message.from.name} · {message.subject}
			</p>
			<p className="mt-2 flex items-center gap-2 text-sm font-medium text-neutral-900">
				<Sparkles className="h-4 w-4 shrink-0 text-violet-500" aria-hidden="true" />
				{suggestion.title}
			</p>
			<p className="mt-1 text-sm leading-6 text-neutral-700">{suggestion.text}</p>
			<p className="mt-3 flex flex-wrap gap-2 text-xs font-medium">
				<button
					type="button"
					data-action="takeSuggestion"
					data-id={message.id}
					className={`rounded-lg bg-blue-600 px-2.5 py-1.5 text-white hover:bg-blue-700 ${FOCUS_RING}`}
				>
					{suggestion.actionLabel}
				</button>
				<button
					type="button"
					data-action="open"
					data-id={message.id}
					className={`rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-neutral-800 hover:bg-neutral-100 ${FOCUS_RING}`}
				>
					Open email
				</button>
				<button
					type="button"
					data-action="dismissSuggestion"
					data-id={message.id}
					className={`rounded-lg px-2.5 py-1.5 text-neutral-600 hover:bg-neutral-100 ${FOCUS_RING}`}
				>
					Dismiss
				</button>
			</p>
		</li>
	);
}

function ForYou({ state }: DemoPartProps) {
	const suggested = suggestedMessages(state);
	return (
		<div className="min-h-0 flex-1 overflow-y-auto bg-[#f6f8fc] px-5 py-4">
			<p className="text-sm text-neutral-600">
				What automatic reading noticed in new mail. Nothing happens until you act, and every action can be undone.
			</p>
			{suggested.length === 0 ? (
				<p className="mt-10 text-center text-sm text-neutral-500">Nothing waiting for you.</p>
			) : (
				GROUPS.map((group) => {
					const cards = suggested.filter((message) => message.suggestion?.kind === group.kind);
					if (cards.length === 0) return null;
					return (
						<section key={group.kind} aria-label={group.title} className="mt-5">
							<h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">{group.title}</h4>
							<ul className="space-y-3">
								{cards.map((message) => (
									<ForYouCard key={message.id} message={message} />
								))}
							</ul>
						</section>
					);
				})
			)}
		</div>
	);
}

function Teaser({ title, text, children }: DemoPanelTeaserProps) {
	return (
		<div className="min-h-0 flex-1 overflow-y-auto bg-[#f6f8fc] px-5 py-4">
			<p className="text-sm text-neutral-600">{text}</p>
			<div className="mt-4 rounded-xl border border-neutral-200 bg-white p-4">{children}</div>
			<p className="mt-3 text-xs text-neutral-500">In Kite, {title} is a full page. The demo shows a glimpse.</p>
		</div>
	);
}

const WEEK = [
	{ day: "Mon 27", events: ["09:30 Support stand-up"] },
	{ day: "Tue 28", events: ["14:00 Launch plan review"] },
	{ day: "Wed 29", events: [] },
	{ day: "Thu 30", events: ["10:00 Planning session (offsite)", "14:00 Onboarding call, Kim"] },
	{ day: "Fri 31", events: ["Booking page: 2 free slots"] },
];

function CalendarGlimpse() {
	return (
		<Teaser
			title="Calendar"
			text="Day, week and month views, repeating events, time zones and invitations by email. Booking pages let anyone pick a free time."
		>
			<ul className="divide-y divide-neutral-100 text-sm">
				{WEEK.map((entry) => (
					<li key={entry.day} className="flex gap-4 py-2">
						<span className="w-16 shrink-0 font-medium text-neutral-900">{entry.day}</span>
						<span className="flex min-w-0 flex-1 flex-col gap-1">
							{entry.events.length === 0 ? (
								<span className="text-neutral-400">Free</span>
							) : (
								entry.events.map((event) => (
									<span key={event} className="flex items-center gap-2 text-neutral-800">
										<CalendarDays className="h-3.5 w-3.5 text-violet-500" aria-hidden="true" />
										{event}
									</span>
								))
							)}
						</span>
					</li>
				))}
			</ul>
		</Teaser>
	);
}

const FILES = [
	{ name: "Launch", kind: "folder", meta: "4 items", icon: Folder, className: "text-blue-500" },
	{ name: "launch-plan.pdf", kind: "file", meta: "47 KB · from Sofia", icon: FileText, className: "text-red-600" },
	{
		name: "offsite-photo.jpg",
		kind: "file",
		meta: "2.1 MB · shared link",
		icon: ImageIcon,
		className: "text-green-600",
	},
	{ name: "support-metrics-q3.pdf", kind: "file", meta: "120 KB", icon: FileText, className: "text-red-600" },
];

function DriveGlimpse() {
	return (
		<Teaser
			title="Drive"
			text="Files and folders next to your mail: resumable uploads, previews, sharing and public links with a password and an expiry. Save an attachment with one click."
		>
			<ul className="grid grid-cols-2 gap-3 text-sm">
				{FILES.map((file) => {
					const Icon = file.icon;
					return (
						<li key={file.name} className="flex items-center gap-3 rounded-lg border border-neutral-200 p-3">
							<Icon className={`h-6 w-6 shrink-0 ${file.className}`} aria-hidden="true" />
							<span className="min-w-0">
								<span className="block truncate font-medium text-neutral-900">{file.name}</span>
								<span className="block truncate text-xs text-neutral-500">{file.meta}</span>
							</span>
						</li>
					);
				})}
			</ul>
			<p className="mt-3 flex items-center gap-2 text-xs text-neutral-500">
				<HardDrive className="h-3.5 w-3.5" aria-hidden="true" />
				2.3 MB of 5 GB used
			</p>
		</Teaser>
	);
}

function SubscriptionsGlimpse({ state }: DemoPartProps) {
	const tracked = !state.messages.find((m) => m.id === "invoice")?.suggestion;
	return (
		<Teaser
			title="Money Watch"
			text="Subscriptions found in receipts and invoices, with their documents, monthly and yearly totals and a reminder before each renewal."
		>
			<ul className="divide-y divide-neutral-100 text-sm">
				<li className="flex items-center gap-3 py-2">
					<Receipt className="h-5 w-5 shrink-0 text-violet-500" aria-hidden="true" />
					<span className="min-w-0 flex-1">
						<span className="block font-medium text-neutral-900">Northwind Cloud</span>
						<span className="block text-xs text-neutral-500">US$49.00/month · renews 12 Nov</span>
					</span>
				</li>
				{tracked && (
					<li className="flex items-center gap-3 py-2">
						<Receipt className="h-5 w-5 shrink-0 text-violet-500" aria-hidden="true" />
						<span className="min-w-0 flex-1">
							<span className="block font-medium text-neutral-900">Fabrikam Team plan</span>
							<span className="block text-xs text-neutral-500">US$17.99/month · renews 3 Nov · invoice attached</span>
						</span>
					</li>
				)}
			</ul>
			<p className="mt-3 text-xs text-neutral-500">
				{tracked
					? "US$66.99 a month, US$803.88 a year."
					: "US$49.00 a month. Track Fabrikam from its invoice to add it."}
			</p>
		</Teaser>
	);
}

/** Replaces the list and the reader when the sidebar shows a page instead of a folder. */
export function DemoPanel(props: DemoPartProps) {
	const { state } = props;
	return (
		<section
			aria-label={demoViewTitles[state.view]}
			className="flex min-w-0 flex-col overflow-hidden bg-white md:col-span-2"
		>
			<PanelHeader title={demoViewTitles[state.view]} appName={props.appName} />
			{state.view === "for-you" && <ForYou {...props} />}
			{state.view === "calendar" && <CalendarGlimpse />}
			{state.view === "drive" && <DriveGlimpse />}
			{state.view === "subscriptions" && <SubscriptionsGlimpse {...props} />}
		</section>
	);
}

export function DemoChat({ state, appName, chatInput, onChatInput, onChatSubmit }: DemoFrameProps) {
	if (!state.chatOpen) return null;
	return (
		<div
			role="dialog"
			aria-label={`${appName} AI`}
			className="absolute inset-y-3 right-3 z-30 flex w-[320px] max-w-[calc(100%-1.5rem)] flex-col rounded-2xl border border-neutral-200 bg-white shadow-2xl"
		>
			<div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2.5 text-sm font-semibold text-neutral-900">
				<span className="flex items-center gap-2">
					<Sparkles className="h-4 w-4 text-violet-500" aria-hidden="true" />
					{appName} AI
				</span>
				<button
					type="button"
					data-action="toggleChat"
					aria-label="Close"
					className={`-mr-1 rounded-md p-1 ${FOCUS_RING}`}
				>
					<X className="h-4 w-4" aria-hidden="true" />
				</button>
			</div>
			<ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3 text-sm" aria-live="polite">
				{state.chat.map((turn, index) => (
					<li
						key={index}
						className={`max-w-[90%] rounded-xl px-3 py-2 leading-6 ${
							turn.role === "user" ? "self-end bg-blue-600 text-white" : "self-start bg-neutral-100 text-neutral-800"
						}`}
					>
						{turn.text}
					</li>
				))}
			</ul>
			<form onSubmit={onChatSubmit} className="flex items-center gap-2 border-t border-neutral-200 px-3 py-2">
				<label className="min-w-0 flex-1">
					<span className="sr-only">Ask about your mail</span>
					<input
						value={chatInput ?? ""}
						onChange={onChatInput ? (event) => onChatInput(event.target.value) : undefined}
						placeholder="Ask about your mail"
						className="h-9 w-full rounded-lg border border-neutral-200 bg-[#f6f8fc] px-3 text-sm text-neutral-900 placeholder:text-neutral-500 focus:border-blue-500 focus:outline-none"
					/>
				</label>
				<button
					type="submit"
					aria-label="Send"
					className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white hover:bg-blue-700 ${FOCUS_RING}`}
				>
					<Send className="h-4 w-4" aria-hidden="true" />
				</button>
			</form>
		</div>
	);
}
