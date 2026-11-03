import { Menu, Search, Star } from "lucide-react";
import { ExampleLabel, PersonAvatar } from "./home-mailbox-cards";
import { FOCUS_RING } from "./home-mailbox-sidebar";
import { listEmails, viewTitle } from "./home-mailbox-state-utils";
import type { HomeEmailMeta, HomeMailboxAction, HomeMailboxState } from "./home-mailbox-types";

type ListProps = {
	state: HomeMailboxState;
	emails: HomeEmailMeta[];
	appName: string;
	icon: string;
	onOpen: (id: string) => void;
	dispatch: (action: HomeMailboxAction) => void;
};

function Row({
	email,
	selected,
	unread,
	starred,
	appName,
	icon,
	showFolder,
	decided,
	onOpen,
}: {
	email: HomeEmailMeta;
	selected: boolean;
	unread: boolean;
	starred: boolean;
	appName: string;
	icon: string;
	showFolder: boolean;
	decided: boolean;
	onOpen: (id: string) => void;
}) {
	const sender = email.sample?.sender ?? { name: appName, address: "", initial: "", own: false, brand: true };
	return (
		<li className={selected ? "bg-neutral-100" : ""}>
			<button
				type="button"
				onClick={() => onOpen(email.id)}
				aria-current={selected ? "true" : undefined}
				className={`flex w-full min-w-0 items-start gap-3 px-4 py-3 text-left hover:bg-neutral-100 ${FOCUS_RING} focus-visible:ring-inset`}
			>
				<span className="relative mt-0.5 h-9 w-9 shrink-0">
					<PersonAvatar person={sender} icon={icon} size="md" />
					{unread && (
						<span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-blue-500 ring-2 ring-[var(--color-white)]" />
					)}
				</span>
				<span className="min-w-0 flex-1">
					<span className="flex items-baseline justify-between gap-2">
						<span className={`truncate text-sm ${unread ? "font-semibold text-neutral-900" : "text-neutral-800"}`}>
							{unread && <span className="sr-only">Unread </span>}
							{sender.name}
						</span>
						<span className="flex shrink-0 items-center gap-1.5 text-xs text-neutral-500">
							{starred && <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-500" aria-label="Starred" />}
							{showFolder && viewTitle(email.folder)}
						</span>
					</span>
					<span
						className={`mt-0.5 block truncate text-sm ${unread ? "font-medium text-neutral-900" : "text-neutral-700"}`}
					>
						{email.subject}
					</span>
					<span className="mt-0.5 flex items-center gap-1.5">
						<span className="min-w-0 flex-1 truncate text-xs text-neutral-500">{email.preview}</span>
						{email.sample && <ExampleLabel />}
						{email.sample?.screening && !decided && (
							<span className="shrink-0 rounded-full border border-amber-300 bg-amber-50 px-2 py-px text-[11px] font-medium text-amber-800">
								New sender
							</span>
						)}
					</span>
				</span>
			</button>
		</li>
	);
}

/** The message list of the open folder, or of the search across every folder. */
export function HomeList({ state, emails, appName, icon, onOpen, dispatch }: ListProps) {
	const rows = listEmails(state, emails);
	const searching = state.search.trim().length > 0;
	const title = searching ? "Search results" : viewTitle(state.view);
	return (
		<section
			aria-label={title}
			data-home-pane="list"
			className={`${state.pane === "reader" ? "hidden md:flex" : "flex"} min-h-0 min-w-0 flex-col border-r border-neutral-200 bg-white`}
		>
			<div className="flex h-14 shrink-0 items-center gap-3 border-b border-neutral-200 px-4 text-base font-semibold text-neutral-900">
				<button
					type="button"
					aria-label="Open menu"
					onClick={() => dispatch({ type: "toggleMenu" })}
					className={`flex h-8 w-8 items-center justify-center rounded-md text-neutral-600 hover:bg-neutral-100 lg:hidden ${FOCUS_RING}`}
				>
					<Menu className="h-4 w-4" aria-hidden="true" />
				</button>
				{title}
			</div>
			<div className="shrink-0 px-4 py-3">
				<label className="flex h-10 items-center gap-3 rounded-lg border border-neutral-200 bg-[#f6f8fc] px-3 text-sm text-neutral-500 focus-within:border-blue-500">
					<Search className="h-4 w-4 shrink-0" aria-hidden="true" />
					<span className="sr-only">Search mail</span>
					<input
						type="search"
						placeholder="Search mail"
						value={state.search}
						onChange={(event) => dispatch({ type: "search", text: event.target.value })}
						className="min-w-0 flex-1 bg-transparent text-neutral-900 placeholder:text-neutral-500 focus:outline-none"
					/>
				</label>
			</div>
			<div className="home-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
				{rows.length === 0 ? (
					<p className="px-6 py-10 text-center text-sm text-neutral-500">
						{searching ? `No mail matches "${state.search}".` : "Nothing here."}
					</p>
				) : (
					<ul aria-label={`${title} messages`} className="divide-y divide-neutral-100">
						{rows.map((email) => (
							<Row
								key={email.id}
								email={email}
								selected={email.id === state.openId}
								unread={!state.read.includes(email.id)}
								starred={state.starred.includes(email.id)}
								appName={appName}
								icon={icon}
								showFolder={searching || state.view === "starred"}
								decided={state.decided.includes(email.id)}
								onOpen={onOpen}
							/>
						))}
					</ul>
				)}
			</div>
		</section>
	);
}
