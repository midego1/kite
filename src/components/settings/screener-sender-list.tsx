"use client";

import { Button } from "@/components/ui/button";
import type { ScreenerSenderEntry } from "@/lib/screener/screener-types";

export function ScreenerSenderList({
	title,
	emptyText,
	entries,
	canManage,
	disabled,
	actionLabel,
	onAction,
}: {
	title: string;
	emptyText: string;
	entries: ScreenerSenderEntry[];
	canManage: boolean;
	disabled: boolean;
	actionLabel: string;
	onAction: (address: string) => void;
}) {
	return (
		<section aria-label={title} className="space-y-2">
			<h4 className="text-sm font-medium text-neutral-900">
				{title} <span className="font-normal text-neutral-500">({entries.length})</span>
			</h4>
			{entries.length === 0 ? (
				<p className="text-sm text-neutral-500">{emptyText}</p>
			) : (
				<ul className="max-h-64 divide-y divide-neutral-100 overflow-y-auto rounded-xl border border-neutral-200">
					{entries.map((entry) => (
						<li key={entry.address} className="flex items-center gap-3 px-3 py-2 text-sm">
							<span className="min-w-0 flex-1 truncate text-neutral-900">{entry.address}</span>
							{entry.source === "sent" && <span className="text-xs text-neutral-500">You wrote to them</span>}
							{canManage && (
								<Button
									type="button"
									size="sm"
									variant="ghost"
									disabled={disabled}
									onClick={() => onAction(entry.address)}
									aria-label={`${actionLabel} ${entry.address}`}
								>
									{actionLabel}
								</Button>
							)}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
