"use client";

import clsx from "clsx";
import type { MouseEvent } from "react";
import { Clock, TriangleAlert, type LucideIcon } from "lucide-react";
import { SuggestionBadge } from "@/components/agent/suggestion-badge";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import type { Message } from "@/hooks/types";
import type { SuggestionCount } from "@/lib/agent/auto-read/suggestion-types";
import { getMessageRowBadges } from "./message-row-badges-utils";

type MessageRowStarProps = {
	starred: boolean;
	compact: boolean;
	icon: LucideIcon;
	onToggle: (event: MouseEvent<HTMLButtonElement>) => void;
};

/** One name for both states, so assistive technology reads the state from `aria-pressed`. */
export function MessageRowStar({ starred, compact, icon: Icon, onToggle }: MessageRowStarProps) {
	const iconColor = starred ? "fill-amber-400 text-amber-400" : compact ? "text-neutral-400" : "text-neutral-300";
	return (
		<Tooltip label={starred ? "Starred" : "Not starred"}>
			{compact ? (
				<button
					type="button"
					onClick={onToggle}
					aria-label="Star"
					aria-pressed={starred}
					className={clsx(
						"rounded p-0.5 hover:bg-neutral-200",
						!starred && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
					)}
				>
					<Icon className={clsx("h-3.5 w-3.5", iconColor)} />
				</button>
			) : (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="relative z-10"
					onClick={onToggle}
					aria-label="Star"
					aria-pressed={starred}
				>
					<Icon className={clsx("h-4 w-4", iconColor)} />
				</Button>
			)}
		</Tooltip>
	);
}

type MessageRowPartyProps = {
	party: string;
	unread: boolean;
	threadCount?: number;
	suggestions?: SuggestionCount[];
	className: string;
	countClassName: string;
};

export function MessageRowParty({
	party,
	unread,
	threadCount = 1,
	suggestions,
	className,
	countClassName,
}: MessageRowPartyProps) {
	return (
		<span className={clsx(unread && "font-semibold", className)}>
			{unread && <span className="sr-only">Unread </span>}
			{party}
			{threadCount > 1 && (
				<span className={clsx("ml-1.5 text-neutral-500", countClassName)}>
					<span aria-hidden="true">[</span>
					{threadCount}
					<span aria-hidden="true">]</span>
				</span>
			)}
			<SuggestionBadge suggestions={suggestions} />
		</span>
	);
}

/** The blue dot that marks an unread row; the "Unread" text for screen readers is in `MessageRowParty`. */
export function UnreadDot({ unread }: { unread: boolean }) {
	return (
		<span
			aria-hidden="true"
			className={clsx("h-2 w-2 shrink-0 rounded-full", unread ? "bg-blue-500" : "bg-transparent")}
		/>
	);
}

const BADGE_ICONS = { warning: TriangleAlert, neutral: Clock } as const;

/** A row's state as Zero's small coloured icons; the label stays readable for screen readers and on hover. */
export function MessageRowBadges({ message, folder }: { message: Message; folder: string }) {
	const badges = getMessageRowBadges(message, folder);
	if (badges.length === 0) return null;
	return (
		<span className="flex shrink-0 items-center gap-1">
			{badges.map((badge) => {
				const BadgeIcon = BADGE_ICONS[badge.tone];
				return (
					<span key={badge.label} title={badge.label} className="inline-flex items-center">
						<BadgeIcon
							aria-hidden="true"
							className={clsx("h-3.5 w-3.5", badge.tone === "warning" ? "text-amber-500" : "text-violet-500")}
						/>
						<span className="sr-only">{badge.label}</span>
					</span>
				);
			})}
		</span>
	);
}
