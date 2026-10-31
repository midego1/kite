"use client";

import { FileDown, Printer } from "lucide-react";
import { downloadMessagesPdf, printMessages } from "./print-actions";
import type { PrintMenuItemsProps } from "./print-menu-types";

const ITEM_CLASS =
	"flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100";

/**
 * Print and Download PDF for a message menu; with `print.conversation` they cover every message of the thread.
 * Nothing is drawn without `print`.
 */
export function PrintMenuItems({ print, onSelect }: PrintMenuItemsProps) {
	if (!print) return null;
	const { getSources, conversation } = print;
	return (
		<>
			<button
				type="button"
				className={ITEM_CLASS}
				onClick={() => {
					onSelect?.();
					void printMessages(getSources());
				}}
			>
				<Printer className="h-4 w-4 shrink-0" aria-hidden="true" />
				{conversation ? "Print conversation" : "Print"}
			</button>
			<button
				type="button"
				className={ITEM_CLASS}
				onClick={() => {
					onSelect?.();
					void downloadMessagesPdf(getSources());
				}}
			>
				<FileDown className="h-4 w-4 shrink-0" aria-hidden="true" />
				{conversation ? "Download conversation as PDF" : "Download PDF"}
			</button>
		</>
	);
}
