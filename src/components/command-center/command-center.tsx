"use client";

import { useMemo } from "react";
import { MailPlus, Search } from "lucide-react";
import { useCompose } from "@/components/compose/compose-context";
import { MigrationsNoticeCard } from "@/components/migrations-banner";
import { resolveNavIcon } from "@/components/modules/client-registry";
import { useModules } from "@/components/modules/modules-context";
import { CLIENT_MODULES } from "@/lib/modules/client-data";
import { moduleNavItems } from "@/lib/modules/nav-utils";
import { getUserTimeZone } from "@/lib/time/utils";
import type { MessageFolderConfig } from "@/components/messages/types";
import type { QuickAction } from "./command-center-types";
import { accountLines, dateLabel, greetingFor, hourIn, statusChips } from "./command-center-utils";
import { LazyCommandCenterAdminCard } from "./command-center-admin-card-lazy";
import { CommandCenterAccountsCard } from "./command-center-accounts-card";
import { CommandCenterModuleCards } from "./command-center-module-cards";
import { CommandCenterQuickActions } from "./command-center-quick-actions";
import { CommandCenterStats } from "./command-center-stats";
import { FloatingKite } from "./floating-kite";
import { useCommandCenterData } from "./use-command-center-data";

/** The modules shown as quick actions, at most. */
const MAX_MODULE_ACTIONS = 4;

/**
 * Two cards side by side once the pane is wide enough (the `@2xl` container step), one under the other before;
 * a card alone in the row takes the whole of it.
 */
const CARD_GRID_CLASS = "grid items-start gap-4 @2xl:grid-cols-2 @2xl:[&>*:only-child]:col-span-2";

/**
 * What the empty reading pane shows instead of "Select a message to read" alone: a greeting with the date, the
 * counts that matter as tiles (unread, Screener, For you), the connected accounts and how they are doing, the
 * quick actions, for admins what needs attention (the database notice with Apply now first, then the admin
 * overview's list and what is fine), and the cards modules declare as `reading-pane` slots, which core draws
 * without naming a module, last because they arrive last. Everything comes from data the mailbox loads anyway or
 * from queries the Settings and Admin pages share; nothing here is made up. It is drawn with the app's own tokens:
 * the panel fill for the cards, the style's accent for the icon circles and links, the dialogs' radius, and the
 * sidebar's rows and "New email" button for the rows and tiles.
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
		<div className="@container relative mx-auto w-full max-w-4xl px-6 py-7 text-left @2xl:px-8" data-command-center>
			<FloatingKite />
			<header className="pr-20">
				{/* Small and muted in Kite and Classic; Kite classic sets it in its script face (globals.css). */}
				<p aria-hidden="true" className="command-center-greeting text-sm text-neutral-500">
					{greeting},
				</p>
				<h2 className="mt-0.5 text-2xl font-semibold tracking-tight text-neutral-900">
					<span className="sr-only">{greeting}, </span>
					{data.user?.name || "there"}
				</h2>
				<p className="mt-1 text-sm text-neutral-500">{date}</p>
			</header>

			<div className="mt-6">
				<CommandCenterStats chips={chips} countsLoading={data.countsLoading} />
			</div>

			<div className="mt-4 empty:hidden">
				<MigrationsNoticeCard />
			</div>

			<div className={`mt-4 ${CARD_GRID_CLASS}`}>
				{data.canConnect && <CommandCenterAccountsCard accounts={accounts} />}
				<CommandCenterQuickActions actions={actions} wide={!data.canConnect} />
			</div>

			{data.isAdmin && (
				<div className="mt-4">
					<LazyCommandCenterAdminCard primary={data.primary} />
				</div>
			)}

			{/* After the quick actions, so nothing above moves when a module's card arrives; empty, it takes no room. */}
			<div className={`mt-4 empty:hidden ${CARD_GRID_CLASS}`}>
				<CommandCenterModuleCards mailboxId={data.mailboxId} />
			</div>

			<p className={`mt-8 text-center text-xs text-neutral-500 ${data.countsLoading ? "invisible" : ""}`}>
				Select a message to read · {data.unread > 0 ? `${data.unread} unread in ${config.title}` : "Nothing selected"}
			</p>
		</div>
	);
}
