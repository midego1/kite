import type { ReactNode } from "react";
import {
	CircleDollarSign,
	CircleHelp,
	Inbox,
	Layers,
	Rocket,
	Scale,
	SquarePen,
	Star,
	TriangleAlert,
	X,
	type LucideIcon,
} from "lucide-react";
import { FOLDERS, unreadCount } from "./home-mailbox-state-utils";
import type {
	HomeEmailMeta,
	HomeFolderId,
	HomeMailboxAction,
	HomeMailboxState,
	HomeViewId,
} from "./home-mailbox-types";

const ICONS: Record<HomeFolderId | "starred", LucideIcon> = {
	inbox: Inbox,
	starred: Star,
	features: Layers,
	deploy: Rocket,
	cost: CircleDollarSign,
	compare: Scale,
	limits: TriangleAlert,
	faq: CircleHelp,
};

export const FOCUS_RING =
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1";

type SidebarProps = {
	state: HomeMailboxState;
	emails: HomeEmailMeta[];
	dispatch: (action: HomeMailboxAction) => void;
	mailbox: { name: string; address: string };
	footer: ReactNode;
};

function Item({
	view,
	label,
	state,
	emails,
	dispatch,
}: Omit<SidebarProps, "mailbox" | "footer"> & { view: HomeViewId; label: string }) {
	const Icon = ICONS[view];
	const active = !state.search.trim() && state.view === view;
	const count = unreadCount(state, emails, view);
	return (
		<li>
			<button
				type="button"
				onClick={() => dispatch({ type: "view", view, phone: !window.matchMedia("(min-width: 768px)").matches })}
				aria-current={active ? "page" : undefined}
				className={`flex h-9 w-full items-center justify-between rounded-lg px-3 text-sm ${FOCUS_RING} ${
					active ? "bg-neutral-100 font-medium text-neutral-900" : "text-neutral-600 hover:bg-neutral-100"
				}`}
			>
				<span className="flex items-center gap-3">
					<Icon className="h-4 w-4" aria-hidden="true" />
					{label}
				</span>
				{count > 0 && <span className="text-xs font-medium text-neutral-600">{count}</span>}
			</button>
		</li>
	);
}

/** The folders are the site's navigation. Below lg the sidebar is a menu over the list, as in the app. */
export function HomeSidebar({ state, emails, dispatch, mailbox, footer }: SidebarProps) {
	const rest = FOLDERS.filter((folder) => folder.id !== "inbox");
	return (
		<>
			{state.menuOpen && (
				<button
					type="button"
					aria-label="Close menu"
					onClick={() => dispatch({ type: "closeMenu" })}
					className="absolute inset-0 z-20 bg-black/30 lg:hidden"
				/>
			)}
			<aside
				aria-label="Folders"
				className={`${
					state.menuOpen
						? "absolute inset-y-0 left-0 z-30 flex w-64 shadow-2xl lg:static lg:w-auto lg:shadow-none"
						: "hidden lg:flex"
				} home-scroll min-h-0 min-w-0 flex-col gap-1 overflow-y-auto border-r border-neutral-200 bg-[#f6f8fc] px-3 py-4`}
			>
				<div className="mb-1 flex items-start justify-between gap-2 px-1">
					<div className="min-w-0">
						<p className="text-sm font-semibold text-neutral-900">{mailbox.name}</p>
						<p className="truncate text-xs text-neutral-500">{mailbox.address}</p>
					</div>
					<button
						type="button"
						aria-label="Close menu"
						onClick={() => dispatch({ type: "closeMenu" })}
						className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-600 lg:hidden ${FOCUS_RING}`}
					>
						<X className="h-4 w-4" aria-hidden="true" />
					</button>
				</div>
				<button
					type="button"
					onClick={() => dispatch({ type: "compose", to: "", subject: "" })}
					className={`my-2 flex h-10 items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-white text-sm font-medium text-neutral-900 shadow-sm hover:bg-neutral-100 ${FOCUS_RING}`}
				>
					<SquarePen className="h-4 w-4" aria-hidden="true" />
					New email
				</button>
				<p className="px-3 pb-1 text-xs font-medium text-neutral-500">Core</p>
				<ul className="flex flex-col gap-1">
					<Item view="inbox" label="Inbox" state={state} emails={emails} dispatch={dispatch} />
					<Item view="starred" label="Starred" state={state} emails={emails} dispatch={dispatch} />
				</ul>
				<p className="px-3 pb-1 pt-3 text-xs font-medium text-neutral-500">Folders</p>
				<ul className="flex flex-col gap-1">
					{rest.map((folder) => (
						<Item
							key={folder.id}
							view={folder.id}
							label={folder.label}
							state={state}
							emails={emails}
							dispatch={dispatch}
						/>
					))}
				</ul>
				<div className="mt-auto pt-4">{footer}</div>
			</aside>
		</>
	);
}
