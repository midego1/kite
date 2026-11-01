"use client";

import Link from "next/link";
import { AlertTriangle, CheckCircle2, CircleMinus, Link2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AccountLine, CommandCenterTone } from "./command-center-types";
import {
	COMMAND_CENTER_LIST_CLASS,
	COMMAND_CENTER_MARK_CLASS,
	COMMAND_CENTER_ROW_CLASS,
	CommandCenterCard,
	CommandCenterEmpty,
	CommandCenterPill,
} from "./command-center-card";

const CONNECTED_ACCOUNTS = { label: "Connected accounts", href: "/settings/connected-accounts" };

/** The mark before an account: a check when it syncs, a warning when it needs the owner, a dash when it is paused or off. */
const MARK_ICON: Record<CommandCenterTone, LucideIcon> = {
	ok: CheckCircle2,
	warn: AlertTriangle,
	muted: CircleMinus,
};

/**
 * The Accounts card: the connected accounts and how they are doing, failures first with a way to fix them, each
 * other one with a pill saying when it last synced; an offer to connect one when there is none.
 */
export function CommandCenterAccountsCard({ accounts }: { accounts: AccountLine[] }) {
	return (
		<CommandCenterCard title="Accounts" icon={Link2} action={CONNECTED_ACCOUNTS} testId="command-center-accounts">
			{accounts.length === 0 ? (
				<CommandCenterEmpty icon={Link2} action={{ label: "Connect an account", href: CONNECTED_ACCOUNTS.href }}>
					Connect Gmail, iCloud or another account to read it here.
				</CommandCenterEmpty>
			) : (
				<ul className={COMMAND_CENTER_LIST_CLASS}>
					{accounts.map((line) => {
						const Mark = MARK_ICON[line.tone];
						return (
							<li key={line.id} className={COMMAND_CENTER_ROW_CLASS} data-account-status={line.tone}>
								<Mark className={cn("h-4 w-4 shrink-0", COMMAND_CENTER_MARK_CLASS[line.tone])} aria-hidden="true" />
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
									<CommandCenterPill tone={line.tone} className="ml-auto">
										{line.detail}
									</CommandCenterPill>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</CommandCenterCard>
	);
}
