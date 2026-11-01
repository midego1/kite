"use client";

import Link from "next/link";
import { Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import type { QuickAction } from "./command-center-types";
import { COMMAND_CENTER_ICON_CLASS, COMMAND_CENTER_TILE_CLASS, CommandCenterCard } from "./command-center-card";

/** A quick action is a tile: the icon in its circle, the label and, at the right, the key that does the same. */
function QuickActionTile({ action }: { action: QuickAction }) {
	const Icon = action.icon;
	const content = (
		<>
			<span className={COMMAND_CENTER_ICON_CLASS}>
				<Icon className="h-4 w-4" aria-hidden="true" />
			</span>
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
			className={cn("w-full text-left", COMMAND_CENTER_TILE_CLASS)}
			data-quick-action={action.id}
		>
			{content}
		</button>
	);
}

/**
 * The Quick actions card: New email, Search and the modules' pages as tiles, two across in a half-width card and
 * four across when the card has the row to itself (`wide`).
 */
export function CommandCenterQuickActions({ actions, wide }: { actions: QuickAction[]; wide: boolean }) {
	return (
		<CommandCenterCard title="Quick actions" icon={Zap} className={cn(wide && "@2xl:col-span-2")}>
			<div className={cn("grid gap-2 @md:grid-cols-2", wide && "@2xl:grid-cols-4")}>
				{actions.map((action) => (
					<QuickActionTile key={action.id} action={action} />
				))}
			</div>
		</CommandCenterCard>
	);
}
