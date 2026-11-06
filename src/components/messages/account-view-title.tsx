"use client";

import { ArrowLeft } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * The list's title while a connected account's view is open: the way back (to the plain list of the folder) and the
 * view's name, with the account's address in its tooltip. The search box next to it stays for searching within the view.
 */
export function AccountViewTitle({
	view,
	folder,
}: {
	view: { address: string; label: string; close: () => void };
	folder: string;
}) {
	return (
		<div data-account-view-title={view.address} className="flex min-w-0 items-center gap-1">
			<Tooltip label={`Back to ${folder}`}>
				<button
					type="button"
					aria-label={`Back to ${folder}`}
					onClick={view.close}
					className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
				>
					<ArrowLeft aria-hidden className="h-4 w-4 rtl:-scale-x-100" />
				</button>
			</Tooltip>
			<p
				title={`Only mail that came in through ${view.address}`}
				className="min-w-0 truncate text-base font-medium text-neutral-900"
			>
				{view.label}
			</p>
		</div>
	);
}
