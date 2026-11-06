"use client";

import { Link2 } from "lucide-react";
import { useOptionalMailSearch } from "@/components/mail-search/mail-search-context";
import type { Message } from "@/hooks/types";
import { viaChipText, viaChipTitle } from "@/lib/external-accounts/via-utils";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/use-t";
import { accountLabelColor } from "./label-colors-utils";
import { useLabelColors } from "./use-label-colors";

const chipClass =
	"inline-flex min-w-0 max-w-40 shrink items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600";

/**
 * "via Gmail" on a message that came in by a connected account (or a sent copy that went out through one). In a list
 * row it is a label inside the row's link (`compact`: just the link icon, with the account in its accessible name and
 * tooltip); in the reader (`filter`) it opens the view of everything that came through that account.
 */
export function ViaAccountChip({
	message,
	filter = false,
	compact = false,
	className,
}: {
	message: Pick<Message, "via" | "direction">;
	filter?: boolean;
	compact?: boolean;
	className?: string;
}) {
	const t = useT();
	const search = useOptionalMailSearch();
	const colors = useLabelColors();
	const { via } = message;
	if (!via) return null;
	// The colour chosen for the account, else the neutral icon.
	const iconColor = accountLabelColor(colors, via.accountId) ?? undefined;
	const text = viaChipText(via);
	const title = viaChipTitle(via, message.direction);
	if (compact && !filter)
		return (
			<span
				role="img"
				data-via-account={via.address}
				data-label-variant="compact"
				aria-label={t("via {text}", { text })}
				title={t("via {text}. {title}", { text, title })}
				className={cn("inline-flex h-4 w-3.5 shrink-0 items-center justify-center text-neutral-500", className)}
			>
				<Link2 aria-hidden="true" className="h-3.5 w-3.5" style={{ color: iconColor }} />
			</span>
		);
	const content = (
		<>
			<Link2 aria-hidden="true" className="h-3 w-3 shrink-0" style={{ color: iconColor }} />
			<span className="truncate">{t("via {text}", { text })}</span>
		</>
	);
	if (filter && search)
		return (
			<button
				type="button"
				data-via-account={via.address}
				title={t("{title}. Show all mail through this account", { title })}
				aria-label={t("via {text}: show all mail through {address}", { text, address: via.address })}
				onClick={() => search.setView(via.address)}
				className={cn(
					chipClass,
					"hover:bg-neutral-200 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600",
					className,
				)}
			>
				{content}
			</button>
		);
	return (
		<span data-via-account={via.address} title={title} className={cn(chipClass, className)}>
			{content}
		</span>
	);
}
