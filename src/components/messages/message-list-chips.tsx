"use client";

import type { LucideIcon } from "lucide-react";
import { Clock, Mail, Paperclip, Star, UserCheck, Zap } from "lucide-react";
import { useMailSearch } from "@/components/mail-search/mail-search-context";
import { FilterChip } from "@/components/ui/filter-chip";
import { Tooltip } from "@/components/ui/tooltip";
import type { MessageListHeaderProps } from "./message-list-header-types";
import { hasSearchTerm, toggleSearchTerm, withoutChipTerms, type ChipSearchTerm } from "./message-list-chips-utils";
import { useT } from "@/lib/i18n/use-t";

type Chip = {
	key: string;
	label: string;
	icon: LucideIcon;
	active: boolean;
	onClick?: () => void;
	href?: string;
};

function ChipButton({ chip }: { chip: Chip }) {
	const control = (
		<FilterChip
			active={chip.active}
			icon={chip.icon}
			fillIcon={chip.key === "all"}
			label={t(chip.label)}
			iconOnly={!chip.active}
			href={chip.href}
			onClick={chip.onClick}
			className={chip.active ? "min-w-0 max-w-60 flex-1" : undefined}
		/>
	);
	return chip.active ? control : <Tooltip label={t(chip.label)}>{control}</Tooltip>;
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
	const t = useT();
	const { input: query, setQuery } = useMailSearch();
	const unread = filter?.value === "unread";
	const term = (value: ChipSearchTerm) => hasSearchTerm(query, value);
	const anyTerm = term("has:attachment") || term("is:starred");
	const inbox = config.folder === "inbox" && !config.folderId;
	const chips: Chip[] = [
		{
			key: "all",
			label: inbox ? t("Primary") : t("All mail"),
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
			label: t("Unread"),
			icon: Mail,
			active: unread,
			onClick: () => filter.onChange(unread ? "all" : "unread"),
		});
	chips.push(
		{
			key: "attachments",
			label: t("Attachments"),
			icon: Paperclip,
			active: term("has:attachment"),
			onClick: () => setQuery(toggleSearchTerm(query, "has:attachment")),
		},
		{
			key: "starred",
			label: t("Starred"),
			icon: Star,
			active: term("is:starred"),
			onClick: () => setQuery(toggleSearchTerm(query, "is:starred")),
		},
	);
	if (inbox) {
		chips.push({ key: "snoozed", label: t("Snoozed"), icon: Clock, active: false, href: "/snoozed" });
		if (screenerVisible)
			chips.push({ key: "screener", label: t("Screener"), icon: UserCheck, active: false, href: "/screener" });
	}
	return (
		<div role="group" aria-label={t("Show")} className="flex items-center gap-2">
			{chips.map((chip) => (
				<ChipButton key={chip.key} chip={chip} />
			))}
		</div>
	);
}
