import {
	Archive,
	ArrowLeft,
	CalendarDays,
	ChevronDown,
	Clock,
	CornerUpLeft,
	EllipsisVertical,
	FileText,
	MailOpen,
	PenSquare,
	Sparkles,
	Star,
	Trash2,
	X,
} from "lucide-react";
import { findMessage } from "./home-demo-state-utils";
import { FOCUS_RING, PRIMARY_BUTTON, SECONDARY_BUTTON } from "./home-demo-parts";
import type { DemoMessage, DemoPartProps, DemoPerson, DemoState } from "./home-demo-types";

/* The reading pane and the composer of the demo, in the classes of the real reader (reader-thread-header.tsx). */

const TOOL_BUTTON = `flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-100 text-neutral-700 hover:bg-neutral-200 ${FOCUS_RING}`;

function Avatar({ person, size = "h-9 w-9 text-sm" }: { person: DemoPerson; size?: string }) {
	return (
		<span
			className={`flex shrink-0 items-center justify-center rounded-full font-medium ${size} ${person.avatarClassName}`}
		>
			{person.initial}
		</span>
	);
}

function Toolbar({ message }: { message: DemoMessage }) {
	const id = message.id;
	return (
		<div className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 px-4 text-neutral-600">
			<span className="flex items-center gap-2">
				<button type="button" data-action="back" aria-label="Back to list" className={`${TOOL_BUTTON} md:hidden`}>
					<ArrowLeft className="h-4 w-4" aria-hidden="true" />
				</button>
				<button
					type="button"
					data-action="summarize"
					data-id={id}
					className={`inline-flex h-8 items-center gap-1.5 rounded-lg bg-neutral-100 px-2.5 text-sm font-medium text-neutral-900 hover:bg-neutral-200 ${FOCUS_RING}`}
				>
					<Sparkles className="h-4 w-4" aria-hidden="true" />
					Summarize
				</button>
			</span>
			<span className="flex items-center gap-1">
				<button type="button" data-action="archive" data-id={id} aria-label="Archive" className={TOOL_BUTTON}>
					<Archive className="h-4 w-4" aria-hidden="true" />
				</button>
				<button type="button" data-action="snooze" data-id={id} aria-label="Snooze" className={TOOL_BUTTON}>
					<Clock className="h-4 w-4" aria-hidden="true" />
				</button>
				<button
					type="button"
					data-action="star"
					data-id={id}
					aria-label={message.starred ? "Unstar" : "Star"}
					aria-pressed={message.starred}
					className={TOOL_BUTTON}
				>
					<Star className={`h-4 w-4 ${message.starred ? "fill-amber-400 text-amber-400" : ""}`} aria-hidden="true" />
				</button>
				<button type="button" data-action="trash" data-id={id} aria-label="Move to Trash" className={TOOL_BUTTON}>
					<Trash2 className="h-4 w-4" aria-hidden="true" />
				</button>
				<EllipsisVertical className="ml-1 h-4 w-4" aria-hidden="true" />
			</span>
		</div>
	);
}

function SuggestionCard({ message }: { message: DemoMessage }) {
	if (!message.suggestion) return null;
	return (
		<div className="rounded-xl border border-neutral-200 bg-[#f6f8fc] p-4" data-testid="demo-suggestion">
			<p className="flex items-center gap-2 text-sm font-medium text-neutral-900">
				<Sparkles className="h-4 w-4 shrink-0 text-violet-500" aria-hidden="true" />
				<span className="min-w-0">{message.suggestion.title}</span>
				<span className="ml-auto shrink-0 text-xs font-normal text-neutral-500">Suggestion, nothing sent</span>
			</p>
			<p className="mt-2 text-sm leading-6 text-neutral-700">{message.suggestion.text}</p>
			<p className="mt-3 flex gap-2">
				<button type="button" data-action="takeSuggestion" data-id={message.id} className={PRIMARY_BUTTON}>
					{message.suggestion.actionLabel}
				</button>
				<button type="button" data-action="dismissSuggestion" data-id={message.id} className={SECONDARY_BUTTON}>
					Dismiss
				</button>
			</p>
		</div>
	);
}

function SummaryCard({ message }: { message: DemoMessage }) {
	return (
		<div className="rounded-xl border border-violet-200 bg-violet-50 p-4 text-sm" data-testid="demo-summary">
			<p className="flex items-center gap-2 font-medium text-neutral-900">
				<Sparkles className="h-4 w-4 text-violet-500" aria-hidden="true" />
				Summary
			</p>
			<p className="mt-2 leading-6 text-neutral-800">{message.summary.overview}</p>
			{message.summary.points.length > 0 && (
				<ul className="mt-2 list-disc space-y-1 pl-5 text-neutral-700">
					{message.summary.points.map((point) => (
						<li key={point}>{point}</li>
					))}
				</ul>
			)}
		</div>
	);
}

function ScreenerBar({ message }: { message: DemoMessage }) {
	return (
		<div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
			<span className="min-w-0 flex-1">
				<strong>{message.from.name}</strong> is new. Decide once whether you want their mail.
			</span>
			<span className="flex gap-2">
				<button type="button" data-action="approve" data-id={message.id} className={PRIMARY_BUTTON}>
					Approve
				</button>
				<button type="button" data-action="deny" data-id={message.id} className={SECONDARY_BUTTON}>
					Deny
				</button>
			</span>
		</div>
	);
}

function EarlierMessages({ message, state }: { message: DemoMessage; state: DemoState }) {
	if (!message.earlier) return null;
	const expanded = state.expanded.includes(message.id);
	return (
		<div className="border-t border-neutral-200 pt-3">
			<button
				type="button"
				data-action="expand"
				data-id={message.id}
				aria-expanded={expanded}
				className={`flex items-center gap-2 rounded-md text-sm text-neutral-600 hover:text-neutral-900 ${FOCUS_RING}`}
			>
				<ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden="true" />
				{expanded ? "Hide" : "Show"} {message.earlier.length} earlier messages
			</button>
			{expanded && (
				<ul className="mt-3 space-y-3">
					{message.earlier.map((earlier) => (
						<li key={earlier.time} className="flex items-start gap-3 text-sm">
							<Avatar person={earlier.from} size="h-7 w-7 text-xs" />
							<span className="min-w-0">
								<span className="font-medium text-neutral-900">{earlier.from.name}</span>
								<span className="ml-2 text-xs text-neutral-500">{earlier.time}</span>
								<span className="mt-1 block text-neutral-700">{earlier.body}</span>
							</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function OpenMessage({ message, state }: { message: DemoMessage; state: DemoState }) {
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
			<div>
				<h3 className="text-xl font-semibold tracking-tight text-neutral-900">
					{message.subject}
					{message.earlier && <span className="ml-2 font-normal text-neutral-500">[{message.earlier.length + 1}]</span>}
				</h3>
				<p className="mt-1 flex items-center gap-2 text-sm text-neutral-500">
					<CalendarDays className="h-4 w-4" aria-hidden="true" />
					{message.sentAt}
				</p>
				<ul className="mt-3 flex flex-wrap gap-2" aria-label="People in this conversation">
					{message.participants.map((person) => (
						<li
							key={person.address}
							className="inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white py-1 pl-1 pr-3 text-sm text-neutral-800"
							title={person.address}
						>
							<Avatar person={person} size="h-6 w-6 text-xs" />
							{person.name}
						</li>
					))}
				</ul>
			</div>
			{message.screening && <ScreenerBar message={message} />}
			{state.summarized.includes(message.id) && <SummaryCard message={message} />}
			<SuggestionCard message={message} />
			<EarlierMessages message={message} state={state} />
			<div className="border-t border-neutral-200 pt-5">
				<div className="flex items-start gap-3">
					<Avatar person={message.from} />
					<div className="min-w-0 flex-1">
						<p className="flex items-baseline justify-between gap-3 text-sm">
							<span className="min-w-0 truncate">
								<span className="font-semibold text-neutral-900">{message.from.name}</span>
								<span className="ml-1.5 text-neutral-500">&lt;{message.from.address}&gt;</span>
							</span>
							<span className="hidden shrink-0 text-neutral-500 xl:inline">{message.sentAt}</span>
						</p>
						<p className="text-xs text-neutral-500">to {message.to}</p>
					</div>
				</div>
				<div className="mt-4 space-y-3 text-[15px] leading-7 text-neutral-800">
					{message.body.map((paragraph) => (
						<p key={paragraph}>{paragraph}</p>
					))}
				</div>
				{message.attachments.length > 0 && (
					<>
						<p className="mt-5 text-sm text-neutral-500">Attachments ({message.attachments.length})</p>
						<ul className="mt-2 flex flex-wrap gap-2">
							{message.attachments.map((attachment) => (
								<li
									key={attachment.name}
									className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-[#f6f8fc] px-3 py-2 text-sm text-neutral-800"
								>
									<FileText className={`h-4 w-4 ${attachment.iconClassName}`} aria-hidden="true" />
									{attachment.name}
									<span className="text-neutral-500">{attachment.size}</span>
								</li>
							))}
						</ul>
					</>
				)}
				{message.status !== "draft" && (
					<div className="mt-4 flex gap-2 text-sm font-medium text-neutral-800">
						<button
							type="button"
							data-action="reply"
							data-id={message.id}
							className={`inline-flex items-center gap-2 rounded-lg bg-neutral-100 px-3 py-2 hover:bg-neutral-200 ${FOCUS_RING}`}
						>
							<CornerUpLeft className="h-4 w-4" aria-hidden="true" />
							Reply
						</button>
					</div>
				)}
			</div>
			{message.status !== "draft" && (
				<button
					type="button"
					data-action="reply"
					data-id={message.id}
					className={`mt-auto flex h-12 shrink-0 items-center gap-3 rounded-xl border border-neutral-200 px-4 text-left text-sm text-neutral-500 hover:border-neutral-300 ${FOCUS_RING}`}
				>
					<PenSquare className="h-4 w-4" aria-hidden="true" />
					Reply to {message.from.name}…
				</button>
			)}
		</div>
	);
}

export function DemoReader({ state }: DemoPartProps) {
	const message = findMessage(state, state.openId);
	return (
		<section
			aria-label="Reading pane"
			className={`${state.mobilePane === "reader" ? "flex" : "hidden md:flex"} min-w-0 flex-col overflow-hidden bg-white`}
		>
			{message ? (
				<>
					<Toolbar message={message} />
					<OpenMessage message={message} state={state} />
				</>
			) : (
				<div className="flex h-full items-center justify-center p-8 text-center">
					<div>
						<div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-neutral-100 text-neutral-400">
							<MailOpen className="h-6 w-6" aria-hidden="true" />
						</div>
						<h3 className="mt-4 text-base font-medium text-neutral-700">Select a message to read</h3>
						<p className="mt-1 text-sm text-neutral-500">Nothing selected</p>
					</div>
				</div>
			)}
		</section>
	);
}

export function DemoComposer({ state, appName }: DemoPartProps) {
	const composer = state.composer;
	if (!composer) return null;
	return (
		<div
			role="dialog"
			aria-label="New message"
			className="absolute inset-x-0 bottom-0 z-30 flex max-h-[85%] flex-col rounded-t-2xl border border-neutral-200 bg-white shadow-2xl md:inset-x-auto md:bottom-4 md:right-4 md:w-[440px] md:rounded-2xl"
		>
			<div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2.5 text-sm font-semibold text-neutral-900">
				New message
				<button
					type="button"
					data-action="closeComposer"
					aria-label="Close"
					className={`-mr-1 rounded-md p-1 ${FOCUS_RING}`}
				>
					<X className="h-4 w-4" aria-hidden="true" />
				</button>
			</div>
			<div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-4 py-3 text-sm">
				<label className="flex items-center gap-2 border-b border-neutral-200 pb-2 focus-within:border-blue-500">
					<span className="w-14 text-neutral-500">To</span>
					<input
						defaultValue={composer.to}
						className="min-w-0 flex-1 bg-transparent text-neutral-900 focus:outline-none"
					/>
				</label>
				<label className="flex items-center gap-2 border-b border-neutral-200 pb-2 focus-within:border-blue-500">
					<span className="w-14 text-neutral-500">Subject</span>
					<input
						defaultValue={composer.subject}
						className="min-w-0 flex-1 bg-transparent text-neutral-900 focus:outline-none"
					/>
				</label>
				{composer.fromAssistant && (
					<p className="flex items-center gap-2 rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-900">
						<Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
						{appName} AI wrote this draft. Read it before you send it.
					</p>
				)}
				<label className="flex flex-col gap-1">
					<span className="sr-only">Message</span>
					<textarea
						defaultValue={composer.body}
						rows={6}
						className="w-full resize-none rounded-lg border border-neutral-200 bg-[#f6f8fc] px-3 py-2 leading-6 text-neutral-900 focus:border-blue-500 focus:outline-none"
					/>
				</label>
			</div>
			<div className="flex items-center gap-2 border-t border-neutral-200 px-4 py-3">
				<button type="button" data-action="send" className={`${PRIMARY_BUTTON} px-4 py-2 text-sm`}>
					Send
				</button>
				<button type="button" data-action="closeComposer" className={`${SECONDARY_BUTTON} px-4 py-2 text-sm`}>
					Discard
				</button>
				<span className="ml-auto text-xs text-neutral-500">Demo: nothing is sent</span>
			</div>
		</div>
	);
}
