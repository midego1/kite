"use client";

import clsx from "clsx";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { Clock, Mail, Paperclip, Star, UserCheck, Zap } from "lucide-react";
import { useMailSearch } from "@/components/mail-search/mail-search-context";
import { Tooltip } from "@/components/ui/tooltip";
import type { MessageListHeaderProps } from "./message-list-header-types";
import { hasSearchTerm, toggleSearchTerm, withoutChipTerms, type ChipSearchTerm } from "./message-list-chips-utils";

type Chip = {
	key: string;
	label: string;
	icon: LucideIcon;
	active: boolean;
	onClick?: () => void;
	href?: string;
};

const chipClass =
	"inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500";

function ChipButton({ chip }: { chip: Chip }) {
	const Icon = chip.icon;
	const className = clsx(
		chipClass,
		chip.active
			? "min-w-0 max-w-60 flex-1 bg-blue-500 px-3 text-[#fff]"
			: "w-8 bg-neutral-100 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900",
	);
	const content = (
		<>
			<Icon className="h-4 w-4 shrink-0" fill={chip.active && chip.key === "all" ? "currentColor" : "none"} />
			{chip.active && <span className="truncate">{chip.label}</span>}
		</>
	);
	const control = chip.href ? (
		<Link href={chip.href} aria-label={chip.label} className={className}>
			{content}
		</Link>
	) : (
		<button
			type="button"
			aria-label={chip.label}
			aria-pressed={chip.active}
			onClick={chip.onClick}
			className={className}
		>
			{content}
		</button>
	);
	return chip.active ? control : <Tooltip label={chip.label}>{control}</Tooltip>;
}

/**
 * Zero's category row, built from filters Kite already has: everything ("Primary" in the Inbox), unread, mail
 * with attachments and starred mail (search terms the server understands), and links to Snoozed and the
 * Screener. The active chip widens and shows its name; the rest are icon squares.
 */
export function MessageListChips({
	config,
	filter,
	screenerVisible,
}: Pick<MessageListHeaderProps, "config" | "filter"> & { screenerVisible: boolean }) {
	const { input: query, setQuery } = useMailSearch();
	const unread = filter?.value === "unread";
	const term = (value: ChipSearchTerm) => hasSearchTerm(query, value);
	const anyTerm = term("has:attachment") || term("is:starred");
	const inbox = config.folder === "inbox" && !config.folderId;
	const chips: Chip[] = [
		{
			key: "all",
			label: inbox ? "Primary" : "All mail",
			icon: Zap,
			active: !unread && !anyTerm,
			onClick: () => {
				filter?.onChange("all");
				setQuery(withoutChipTerms(query));
			},
		},
	];
	if (filter)
		chips.push({
			key: "unread",
			label: "Unread",
			icon: Mail,
			active: unread,
			onClick: () => filter.onChange(unread ? "all" : "unread"),
		});
	chips.push(
		{
			key: "attachments",
			label: "Attachments",
			icon: Paperclip,
			active: term("has:attachment"),
			onClick: () => setQuery(toggleSearchTerm(query, "has:attachment")),
		},
		{
			key: "starred",
			label: "Starred",
			icon: Star,
			active: term("is:starred"),
			onClick: () => setQuery(toggleSearchTerm(query, "is:starred")),
		},
	);
	if (inbox) {
		chips.push({ key: "snoozed", label: "Snoozed", icon: Clock, active: false, href: "/snoozed" });
		if (screenerVisible)
			chips.push({ key: "screener", label: "Screener", icon: UserCheck, active: false, href: "/screener" });
	}
	return (
		<div role="group" aria-label="Show" className="flex items-center gap-2">
			{chips.map((chip) => (
				<ChipButton key={chip.key} chip={chip} />
			))}
		</div>
	);
}
