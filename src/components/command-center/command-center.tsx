"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Link2, Mail, MailPlus, Search, Sparkles, UserCheck, type LucideIcon } from "lucide-react";
import { useCompose } from "@/components/compose/compose-context";
import { MigrationsNoticeCard } from "@/components/migrations-banner";
import { resolveNavIcon } from "@/components/modules/client-registry";
import { useModules } from "@/components/modules/modules-context";
import { CLIENT_MODULES } from "@/lib/modules/client-data";
import { moduleNavItems } from "@/lib/modules/nav-utils";
import { getUserTimeZone } from "@/lib/time/utils";
import type { MessageFolderConfig } from "@/components/messages/types";
import type { AccountLine, QuickAction, StatusChip } from "./command-center-types";
import { accountLines, dateLabel, greetingFor, hourIn, statusChips } from "./command-center-utils";
import { LazyCommandCenterAdminCard } from "./command-center-admin-card-lazy";
import {
	COMMAND_CENTER_DETAIL_CLASS,
	COMMAND_CENTER_LINK_ROW_CLASS,
	COMMAND_CENTER_ROW_CLASS,
	COMMAND_CENTER_TILE_CLASS,
	CommandCenterCard,
} from "./command-center-card";
import { CommandCenterModuleCards } from "./command-center-module-cards";
import { FloatingKite } from "./floating-kite";
import { useCommandCenterData } from "./use-command-center-data";

/** The modules shown as quick actions, at most. */
const MAX_MODULE_ACTIONS = 4;

/** The counts' icons: the sidebar's own for the Screener and For you, an envelope for the folder's unread mail. */
const CHIP_ICON: Record<StatusChip["id"], LucideIcon> = {
	unread: Mail,
	screener: UserCheck,
	"for-you": Sparkles,
};

/** The row icons' colour: the sidebar's muted grey. */
const ROW_ICON_CLASS = "h-4 w-4 shrink-0 text-neutral-500";

/**
 * The state dot of an account: the notice colours (notice-styles.ts), fixed so the dark themes' inverted scales
 * cannot turn them muddy; grey for an account that is paused or off.
 */
const DOT_CLASS: Record<AccountLine["tone"], string> = {
	ok: "bg-[#22c55e]",
	warn: "bg-[#f59e0b]",
	muted: "bg-neutral-300",
};

/** A quick action is a tile like the sidebar's "New email" button: the icon, the label and, at the right, the key that does the same. */
function QuickActionRow({ action }: { action: QuickAction }) {
	const Icon = action.icon;
	const content = (
		<>
			<Icon className={ROW_ICON_CLASS} aria-hidden="true" />
			<span className="min-w-0 flex-1 truncate">{action.label}</span>
			{action.shortcut && (
				<kbd className="ml-auto rounded border border-neutral-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-neutral-500 shadow-2xs">
					{action.shortcut}
				</kbd>
			)}
		</>
	);
	return action.href ? (
		<Link href={action.href} className={COMMAND_CENTER_TILE_CLASS} data-quick-action={action.id}>
			{content}
		</Link>
	) : (
		<button
			type="button"
			onClick={action.onSelect}
			className={`w-full text-left ${COMMAND_CENTER_TILE_CLASS}`}
			data-quick-action={action.id}
		>
			{content}
		</button>
	);
}

/**
 * What the empty reading pane shows instead of "Select a message to read" alone: a greeting with the date, the
 * counts that matter (unread, Screener, For you), the connected accounts and how they are doing, for admins what
 * needs attention (the database notice with Apply now first, then the admin overview's list and what is fine),
 * and quick actions. Everything comes from data the mailbox loads anyway or from queries the Settings and Admin
 * pages share; nothing here is made up. Modules appear through their sidebar nav items as quick actions and
 * through the cards they declare as `reading-pane` slots, which core draws without naming a module, below the
 * quick actions because they arrive last. It is drawn with the sidebar's and the Settings pages' own parts: small
 * muted group labels, plain rows, the app's notices and, for the quick actions, tiles like the sidebar's "New email" button; no surfaces or colours of its own.
 */
export function CommandCenter({ config }: { config: MessageFolderConfig }) {
	const data = useCommandCenterData(config);
	const { openComposer } = useCompose();
	// The modules' sidebar items, labels and icons only: their counts are the sidebar's business.
	const { modules } = useModules();
	// The greeting and the date are read once per mount: the pane is remounted whenever a message is closed.
	const { greeting, date } = useMemo(() => {
		const now = new Date();
		const timeZone = getUserTimeZone();
		return { greeting: greetingFor(hourIn(now, timeZone)), date: dateLabel(now, timeZone) };
	}, []);
	const now = new Date();
	const chips = statusChips(data.chips);
	const accounts = accountLines({ accounts: data.accounts, now });
	const actions: QuickAction[] = [
		{ id: "compose", label: "New email", icon: MailPlus, shortcut: "C", onSelect: openComposer },
		{
			id: "search",
			label: "Search",
			icon: Search,
			shortcut: "/",
			onSelect: () => {
				const input = document.querySelector<HTMLInputElement>('input[placeholder*="Search"]');
				input?.focus();
				input?.select();
			},
		},
		...moduleNavItems(CLIENT_MODULES, "sidebar", modules)
			.slice(0, MAX_MODULE_ACTIONS)
			.map((item): QuickAction => ({
				id: item.href,
				label: item.label,
				icon: resolveNavIcon(item.icon),
				href: item.href,
			})),
	];

	return (
		<div className="@container relative mx-auto w-full max-w-3xl px-6 py-6 text-left" data-command-center>
			<FloatingKite />
			<div className="px-3">
				{/* Plain, small and muted in Kite and Classic; Kite classic sets it in its script face (globals.css). */}
				<p aria-hidden="true" className="command-center-greeting text-sm text-neutral-500">
					{greeting},
				</p>
				<h2 className="mt-0.5 text-xl font-semibold tracking-tight text-neutral-900">
					<span className="sr-only">{greeting}, </span>
					{data.user?.name || "there"}
				</h2>
				<p className="mt-1 text-sm text-neutral-500">{date}</p>
			</div>

			<div className="mt-4">
				<CommandCenterCard title="Right now">
					<div role="group" aria-label="Right now">
						{chips.map((chip) => {
							const Icon = CHIP_ICON[chip.id];
							return (
								<Link
									key={chip.id}
									href={chip.href}
									data-chip={chip.id}
									className={`${COMMAND_CENTER_LINK_ROW_CLASS} ${
										data.countsLoading && chip.id === "unread" ? "invisible" : ""
									}`}
								>
									<Icon className={ROW_ICON_CLASS} aria-hidden="true" />
									{chip.label}
								</Link>
							);
						})}
					</div>
				</CommandCenterCard>
			</div>

			<div className="mt-4 px-3 empty:hidden">
				<MigrationsNoticeCard />
			</div>

			{data.canConnect && (
				<div className="mt-4">
					<CommandCenterCard
						title="Accounts"
						action={{ label: "Connected accounts", href: "/settings/connected-accounts" }}
						testId="command-center-accounts"
					>
						{accounts.length === 0 ? (
							<Link href="/settings/connected-accounts" className={COMMAND_CENTER_LINK_ROW_CLASS}>
								<Link2 className={ROW_ICON_CLASS} aria-hidden="true" />
								<span className="min-w-0 flex-1 truncate">
									Connect Gmail, iCloud or another account to read it here.
								</span>
							</Link>
						) : (
							<ul>
								{accounts.map((line) => (
									<li key={line.id} className={COMMAND_CENTER_ROW_CLASS} data-account-status={line.tone}>
										<span aria-hidden="true" className={`mx-1 h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[line.tone]}`} />
										<span className="min-w-0 flex-1 truncate">
											<span className="font-medium text-neutral-900">{line.name}</span>
											{line.name !== line.address && <span className="text-neutral-500"> {line.address}</span>}
										</span>
										{line.action ? (
											<Link
												href={line.action.href}
												className="ml-auto inline-flex h-7 shrink-0 items-center rounded-lg border border-neutral-200 bg-white px-2.5 text-xs font-medium text-neutral-900 transition-colors hover:bg-neutral-100"
											>
												{line.action.label}
											</Link>
										) : (
											<span className={COMMAND_CENTER_DETAIL_CLASS}>{line.detail}</span>
										)}
									</li>
								))}
							</ul>
						)}
					</CommandCenterCard>
				</div>
			)}

			{data.isAdmin && (
				<div className="mt-4">
					<LazyCommandCenterAdminCard primary={data.primary} />
				</div>
			)}

			<div className="mt-4">
				<CommandCenterCard title="Quick actions">
					<div className="grid gap-2 px-3 @md:grid-cols-2 @2xl:grid-cols-3">
						{actions.map((action) => (
							<QuickActionRow key={action.id} action={action} />
						))}
					</div>
				</CommandCenterCard>
			</div>

			{/* After the quick actions, so nothing above moves when a module's card arrives; empty, it takes no room. */}
			<div className="mt-4 space-y-4 empty:hidden">
				<CommandCenterModuleCards mailboxId={data.mailboxId} />
			</div>

			<p className={`mt-6 px-3 text-center text-xs text-neutral-500 ${data.countsLoading ? "invisible" : ""}`}>
				Select a message to read · {data.unread > 0 ? `${data.unread} unread in ${config.title}` : "Nothing selected"}
			</p>
		</div>
	);
}
