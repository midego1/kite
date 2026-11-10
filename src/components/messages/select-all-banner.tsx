"use client";

import { useT } from "@/lib/i18n/use-t";

type SelectAllBannerProps = {
	/** Rows matching the current folder and filters, across every page. */
	total: number;
	/** `select-all-utils.ts`'s cap: past it, the button offers only the first `max`. */
	max: number;
	folderLabel: string;
	pending: boolean;
	onSelectAll: () => void;
};

/**
 * Shown above the rows once every row on the page is checked and the folder holds more: offers to extend the
 * selection to everything matching the current folder and filters, resolved from the server (`select-all-utils.ts`).
 */
export function SelectAllBanner({ total, max, folderLabel, pending, onSelectAll }: SelectAllBannerProps) {
	const t = useT();
	const count = Math.min(total, max);
	const label =
		total <= max
			? t("Select all {count} in {folder}", { count, folder: folderLabel })
			: t("Select the first {count} in {folder}", { count, folder: folderLabel });
	return (
		<div role="listitem" className="flex justify-center border-b border-neutral-100 bg-blue-50 px-4 py-2 text-sm">
			<button
				type="button"
				onClick={onSelectAll}
				disabled={pending}
				className="font-medium text-blue-700 underline-offset-2 hover:underline disabled:opacity-50"
			>
				{pending ? t("Selecting…") : label}
			</button>
		</div>
	);
}
