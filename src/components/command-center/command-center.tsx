"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Link2, MailPlus, Search } from "lucide-react";
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
import { COMMAND_CENTER_SURFACE_CLASS, CommandCenterCard } from "./command-center-card";
import { CommandCenterModuleCards } from "./command-center-module-cards";
import { FloatingKite } from "./floating-kite";
import { useCommandCenterData } from "./use-command-center-data";

/** The modules shown as quick actions, at most. */
const MAX_MODULE_ACTIONS = 4;

/** The chips are quiet pills on the shared surface; only their dot carries the tone. */
const CHIP_DOT_CLASS: Record<StatusChip["tone"], string> = {
	blue: "bg-cc-accent-tint",
	amber: "bg-cc-warn",
	violet: "bg-violet-500",
};

const DOT_CLASS: Record<AccountLine["tone"], string> = {
	ok: "bg-cc-ok",
	warn: "bg-cc-warn",
	muted: "bg-neutral-300",
};

/** The quick actions' shared look: an icon, a label and, at the right, the key that does the same. */
function QuickActionTile({ action }: { action: QuickAction }) {
	const Icon = action.icon;
	const className = `flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-neutral-800 transition-colors hover:border-cc-border-strong hover:bg-cc-surface-hover ${COMMAND_CENTER_SURFACE_CLASS}`;
	const content = (
		<>
			<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-cc-accent-tint/12 text-cc-accent-tint">
				<Icon className="h-4 w-4" aria-hidden="true" />
			</span>
			<span className="min-w-0 flex-1 truncate">{action.label}</span>
			{action.shortcut && (
				<kbd className="rounded-md border border-cc-border bg-cc-surface-hover px-1.5 py-0.5 font-mono text-[10px] text-neutral-500">
					{action.shortcut}
				</kbd>
			)}
		</>
	);
	return action.href ? (
		<Link href={action.href} className={className} data-quick-action={action.id}>
			{content}
		</Link>
	) : (
		<button type="button" onClick={action.onSelect} className={className} data-quick-action={action.id}>
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
 * quick actions because they arrive last.
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
		<div className="@container relative mx-auto w-full max-w-3xl px-6 py-7 text-left" data-command-center>
			<FloatingKite />
			<p aria-hidden="true" className="font-script text-3xl leading-none text-blue-600">
				{greeting},
			</p>
			<h2 className="mt-1 text-2xl font-semibold tracking-tight text-neutral-900">
				<span className="sr-only">{greeting}, </span>
				{data.user?.name || "there"}
			</h2>
			<p className="mt-1 text-sm text-neutral-500">{date}</p>

			<div role="group" aria-label="Right now" className="mt-4 flex flex-wrap gap-2">
				{chips.map((chip) => (
					<Link
						key={chip.id}
						href={chip.href}
						data-chip={chip.id}
						className={`inline-flex h-8 items-center gap-2 rounded-full px-3.5 text-[13px] font-medium text-neutral-800 transition-colors hover:border-cc-border-strong hover:bg-cc-surface-hover ${COMMAND_CENTER_SURFACE_CLASS} ${
							data.countsLoading && chip.id === "unread" ? "invisible" : ""
						}`}
					>
						<i aria-hidden="true" className={`h-2 w-2 rounded-full ${CHIP_DOT_CLASS[chip.tone]}`} />
						{chip.label}
					</Link>
				))}
			</div>

			<div className="mt-5">
				<MigrationsNoticeCard />
			</div>

			<div className="mt-5 grid gap-4 @2xl:grid-cols-2">
				{data.canConnect && (
					<CommandCenterCard
						title="Accounts"
						action={{ label: "Connected accounts", href: "/settings/connected-accounts" }}
						testId="command-center-accounts"
					>
						{accounts.length === 0 ? (
							<Link
								href="/settings/connected-accounts"
								className="flex items-center gap-3 py-1.5 text-sm text-neutral-700 hover:text-neutral-900"
							>
								<Link2 className="h-4 w-4 text-neutral-400" aria-hidden="true" />
								Connect Gmail, iCloud or another account to read it here.
							</Link>
						) : (
							<ul className="divide-y divide-cc-border">
								{accounts.map((line) => (
									<li key={line.id} className="flex items-center gap-3 py-2 text-sm" data-account-status={line.tone}>
										<span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[line.tone]}`} />
										<span className="min-w-0 flex-1 truncate">
											<span className="font-medium text-neutral-900">{line.name}</span>
											{line.name !== line.address && <span className="text-neutral-500"> {line.address}</span>}
										</span>
										{line.action ? (
											<Link
												href={line.action.href}
												className="shrink-0 rounded-lg border border-cc-border-strong px-2.5 py-1 text-xs font-medium text-neutral-800 transition-colors hover:bg-cc-surface-hover"
											>
												{line.action.label}
											</Link>
										) : (
											<span className="shrink-0 text-xs text-neutral-500">{line.detail}</span>
										)}
									</li>
								))}
							</ul>
						)}
					</CommandCenterCard>
				)}

				{data.isAdmin && <LazyCommandCenterAdminCard primary={data.primary} />}
			</div>

			<div className="mt-5">
				<h3 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-cc-label">Quick actions</h3>
				<div className="grid gap-2 @md:grid-cols-2 @xl:grid-cols-3">
					{actions.map((action) => (
						<QuickActionTile key={action.id} action={action} />
					))}
				</div>
			</div>

			{/* After the quick actions, so nothing above moves when a module's card arrives; empty, it takes no room. */}
			<div className="mt-5 grid gap-4 empty:hidden @2xl:grid-cols-2">
				<CommandCenterModuleCards mailboxId={data.mailboxId} />
			</div>

			<p className={`mt-6 text-center text-xs text-neutral-400 ${data.countsLoading ? "invisible" : ""}`}>
				Select a message to read · {data.unread > 0 ? `${data.unread} unread in ${config.title}` : "Nothing selected"}
			</p>
		</div>
	);
}
