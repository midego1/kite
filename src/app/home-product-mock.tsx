import {
	Archive,
	ArrowLeft,
	CalendarDays,
	Clock,
	CornerUpLeft,
	CornerUpRight,
	EllipsisVertical,
	FileText,
	FolderInput,
	Menu,
	Paperclip,
	PenSquare,
	RotateCw,
	Search,
	Sparkles,
	SquarePen,
	Star,
	X,
} from "lucide-react";
import { mockMailbox, mockRows, mockSidebarCore, mockSidebarModules, mockThread } from "./home-mock-utils";
import type { HomeMockRow, HomeMockSidebarItem, HomeProductMockProps } from "./types";

/*
 * A static preview of the inbox, built from the same Tailwind classes the real sidebar, message list and reader
 * use (src/components/messages/message-list-row.tsx, reader-thread-header.tsx), so it follows the theme, the
 * style and dark mode like the app does. It renders on the server with no JavaScript and shows invented demo
 * data (home-mock-utils.ts). Screen readers get one description instead of its rows and buttons.
 */

function SidebarItem({ item }: { item: HomeMockSidebarItem }) {
	const Icon = item.icon;
	return (
		<div
			className={`flex h-9 items-center justify-between rounded-lg px-3 text-sm ${
				item.active ? "bg-neutral-100 font-medium text-neutral-900" : "text-neutral-600"
			}`}
		>
			<span className="flex items-center gap-3">
				<Icon className="h-4 w-4" />
				{item.label}
			</span>
			{item.count && <span className="text-xs text-neutral-500">{item.count}</span>}
		</div>
	);
}

function MockSidebar({ appName }: HomeProductMockProps) {
	return (
		<aside className="hidden min-w-0 flex-col gap-1 border-r border-neutral-200 bg-[#f6f8fc] px-3 py-4 lg:flex">
			<div className="mb-3 flex items-center gap-2 px-1 text-neutral-600">
				<Menu className="h-4 w-4" />
				<span className="flex items-center gap-2 text-neutral-900">
					<img src="/kite.svg" alt="" width={20} height={20} />
					<span className="text-base font-bold tracking-tight">{appName}</span>
				</span>
			</div>
			<div className="mb-2 px-1">
				<p className="text-sm font-semibold text-neutral-900">{mockMailbox.name}</p>
				<p className="truncate text-xs text-neutral-500">{mockMailbox.address}</p>
			</div>
			<div className="mb-3 flex h-10 items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-white text-sm font-medium text-neutral-900 shadow-sm">
				<SquarePen className="h-4 w-4" />
				New email
			</div>
			<p className="px-3 pb-1 text-xs font-medium text-neutral-500">Core</p>
			{mockSidebarCore.map((item) => (
				<SidebarItem key={item.label} item={item} />
			))}
			<p className="px-3 pb-1 pt-3 text-xs font-medium text-neutral-500">Modules and folders</p>
			{mockSidebarModules.map((item) => (
				<SidebarItem key={item.label} item={item} />
			))}
		</aside>
	);
}

function UpdateRow({ appName }: HomeProductMockProps) {
	return (
		<div className="flex items-center gap-3 border-b border-neutral-200 bg-[#eef3fb] px-4 py-2.5 text-sm">
			<img src="/kite.svg" alt="" width={20} height={20} />
			<span className="min-w-0 flex-1 truncate text-neutral-900">{appName} was updated</span>
			<span className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-blue-600 px-2.5 text-xs font-medium text-white">
				<RotateCw className="h-3.5 w-3.5" />
				Reload
			</span>
			<X className="h-4 w-4 text-neutral-500" />
		</div>
	);
}

function MockRow({ row }: { row: HomeMockRow }) {
	const Badge = row.badge?.icon;
	return (
		<div
			className={`flex items-start gap-3 px-4 py-3 ${row.selected ? "bg-neutral-100" : ""}`}
			data-selected={row.selected ? "true" : undefined}
		>
			<span className="relative mt-0.5 h-9 w-9 shrink-0">
				<span
					className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-medium ${row.avatarClassName}`}
				>
					{row.initial}
				</span>
				{row.unread && (
					<span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-blue-500 ring-2 ring-[var(--color-white)]" />
				)}
			</span>
			<span className="min-w-0 flex-1">
				<span className="flex items-baseline justify-between gap-2">
					<span className={`truncate text-sm ${row.unread ? "font-semibold text-neutral-900" : "text-neutral-800"}`}>
						{row.sender}
						{row.threadCount && <span className="ml-1.5 font-normal text-neutral-500">[{row.threadCount}]</span>}
					</span>
					<span className="flex shrink-0 items-center gap-1.5 text-xs text-neutral-500">
						{row.attachment && <Paperclip className="h-3.5 w-3.5" />}
						{Badge && <Badge className={`h-3.5 w-3.5 ${row.badge?.className}`} />}
						{row.time}
					</span>
				</span>
				<span className="mt-0.5 flex items-center gap-2">
					<span
						className={`min-w-0 truncate text-sm ${row.unread ? "font-medium text-neutral-900" : "text-neutral-600"}`}
					>
						{row.subject}
					</span>
					{row.chip && (
						<span className="shrink-0 rounded-full border border-amber-300 bg-amber-50 px-2 py-px text-[11px] font-medium text-amber-800">
							{row.chip}
						</span>
					)}
				</span>
			</span>
		</div>
	);
}

function MockList({ appName }: HomeProductMockProps) {
	return (
		<section className="flex min-w-0 flex-col border-r border-neutral-200 bg-white">
			<div className="flex h-14 items-center justify-between border-b border-neutral-200 px-4">
				<span className="flex items-center gap-3 text-base font-semibold text-neutral-900">
					<Menu className="h-4 w-4 text-neutral-500 lg:hidden" />
					Inbox
				</span>
				<span className="flex items-center gap-2 text-sm text-neutral-600">
					<span className="hidden items-center gap-1.5 sm:inline-flex">
						<Sparkles className="h-4 w-4" />
						{appName} AI
					</span>
					<EllipsisVertical className="h-4 w-4" />
				</span>
			</div>
			<div className="px-4 py-3">
				<div className="flex h-10 items-center gap-3 rounded-lg border border-neutral-200 bg-[#f6f8fc] px-3 text-sm text-neutral-500">
					<Search className="h-4 w-4" />
					<span className="flex-1 truncate">Search mail</span>
					<kbd className="rounded border border-neutral-200 px-1.5 text-[11px]">⌘K</kbd>
				</div>
			</div>
			<UpdateRow appName={appName} />
			<div className="divide-y divide-neutral-100">
				{mockRows.map((row) => (
					<MockRow key={row.sender} row={row} />
				))}
			</div>
		</section>
	);
}

function MockReader() {
	return (
		<section className="hidden min-w-0 flex-col bg-white md:flex">
			<div className="flex h-14 items-center justify-between border-b border-neutral-200 px-4 text-neutral-600">
				<span className="flex items-center gap-3">
					<ArrowLeft className="h-4 w-4 md:hidden" />
					<span className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-neutral-100 px-2.5 text-sm font-medium text-neutral-900">
						<Sparkles className="h-4 w-4" />
						Summarize
					</span>
				</span>
				<span className="flex items-center gap-1">
					{[Archive, Clock, FolderInput, Star].map((Icon, index) => (
						<span key={index} className="flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-100">
							<Icon className="h-4 w-4" />
						</span>
					))}
					<EllipsisVertical className="h-4 w-4" />
				</span>
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-5 px-6 py-5">
				<div>
					<h3 className="text-xl font-semibold tracking-tight text-neutral-900">
						{mockThread.subject}
						<span className="ml-2 font-normal text-neutral-500">[{mockThread.count}]</span>
					</h3>
					<p className="mt-1 flex items-center gap-2 text-sm text-neutral-500">
						<CalendarDays className="h-4 w-4" />
						{mockThread.date}
					</p>
					<div className="mt-3 flex flex-wrap gap-2">
						{mockThread.participants.map((person) => (
							<span
								key={person.name}
								className="inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white py-1 pl-1 pr-3 text-sm text-neutral-800"
							>
								<span
									className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${person.avatarClassName}`}
								>
									{person.initial}
								</span>
								{person.name}
							</span>
						))}
					</div>
				</div>

				<div className="rounded-xl border border-neutral-200 bg-[#f6f8fc] p-4">
					<p className="flex items-center gap-2 text-sm font-medium text-neutral-900">
						<Sparkles className="h-4 w-4 text-violet-500" />
						{mockThread.suggestion.title}
						<span className="ml-auto text-xs font-normal text-neutral-500">Suggestion, nothing sent</span>
					</p>
					<p className="mt-2 text-sm leading-6 text-neutral-700">{mockThread.suggestion.text}</p>
					<p className="mt-3 flex gap-2 text-xs font-medium">
						<span className="rounded-lg bg-blue-600 px-2.5 py-1.5 text-white">Review draft</span>
						<span className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-neutral-800">
							Dismiss
						</span>
					</p>
				</div>

				<div className="border-t border-neutral-200 pt-5">
					<div className="flex items-start gap-3">
						<span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-sm font-medium text-neutral-700">
							{mockThread.from.initial}
						</span>
						<div className="min-w-0 flex-1">
							<p className="flex items-baseline justify-between gap-3 text-sm">
								<span className="min-w-0 truncate">
									<span className="font-semibold text-neutral-900">{mockThread.from.name}</span>
									<span className="ml-1.5 text-neutral-500">&lt;{mockThread.from.address}&gt;</span>
								</span>
								<span className="hidden shrink-0 text-neutral-500 xl:inline">{mockThread.sentAt}</span>
							</p>
							<p className="text-xs text-neutral-500">to {mockThread.to}</p>
						</div>
					</div>
					<div className="mt-4 space-y-3 text-[15px] leading-7 text-neutral-800">
						{mockThread.body.map((paragraph) => (
							<p key={paragraph}>{paragraph}</p>
						))}
					</div>
					<p className="mt-5 text-sm text-neutral-500">Attachments ({mockThread.attachments.length})</p>
					<div className="mt-2 flex flex-wrap gap-2">
						{mockThread.attachments.map((attachment) => (
							<span
								key={attachment.name}
								className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-[#f6f8fc] px-3 py-2 text-sm text-neutral-800"
							>
								<FileText className={`h-4 w-4 ${attachment.iconClassName}`} />
								{attachment.name}
								<span className="text-neutral-500">{attachment.size}</span>
								<EllipsisVertical className="h-3.5 w-3.5 text-neutral-500" />
							</span>
						))}
					</div>
					<div className="mt-4 flex gap-2 text-sm font-medium text-neutral-800">
						<span className="inline-flex items-center gap-2 rounded-lg bg-neutral-100 px-3 py-2">
							<CornerUpLeft className="h-4 w-4" />
							Reply
						</span>
						<span className="inline-flex items-center gap-2 rounded-lg bg-neutral-100 px-3 py-2">
							<CornerUpRight className="h-4 w-4" />
							Forward
						</span>
					</div>
				</div>

				<div className="mt-auto flex h-12 items-center gap-3 rounded-xl border border-neutral-200 px-4 text-sm text-neutral-500">
					<PenSquare className="h-4 w-4" />
					Reply to {mockThread.from.name}…
				</div>
			</div>
		</section>
	);
}

export function HomeProductMock({ appName }: HomeProductMockProps) {
	return (
		<div
			role="img"
			aria-label={`A preview of the ${appName} inbox with invented demo data: the folders and modules in the sidebar, the message list with an update row, a sender waiting in the Screener and a subscription found by automatic reading, and an open conversation with its people, attachments and a drafted reply waiting for review.`}
			data-testid="home-product-mock"
			className="relative mx-auto h-[600px] w-full max-w-6xl overflow-hidden rounded-2xl border border-neutral-200 bg-white text-left shadow-[0_30px_80px_-40px_rgba(79,70,229,0.45)] md:h-[700px]"
		>
			<div className="grid h-full grid-cols-1 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:grid-cols-[200px_minmax(0,0.9fr)_minmax(0,1.1fr)]">
				<MockSidebar appName={appName} />
				<MockList appName={appName} />
				<MockReader />
			</div>
			{/* The frame is taller than the list on a phone, so the last rows fade out instead of being cut. */}
			<div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[var(--color-white)] to-transparent md:hidden" />
		</div>
	);
}
