"use client";

import clsx from "clsx";
import { X } from "lucide-react";
import { useBranding } from "@/components/branding-provider";
import { getStackedRowDensity, getWideRowDensity } from "@/components/messages/reading-layout-utils";
import type { MessageListDensity } from "@/components/messages/reading-layout-types";
import { TOAST_ACTION_CLASS } from "@/components/ui/toast-styles";
import { UPDATE_ROW_PREVIEW, UPDATE_ROW_SUBJECT, chooseUpdateSurface } from "./update-available-utils";
import { dismissUpdateNotice, useUpdateNotice } from "./update-notice-store";
import { reloadToNewVersion } from "./update-reload";

const SENDER = "Kite";

function Logo({ className }: { className: string }) {
	const branding = useBranding();
	return (
		<span
			aria-hidden="true"
			className={clsx(
				"flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-100",
				className,
			)}
		>
			{/* eslint-disable-next-line @next/next/no-img-element */}
			<img src={branding.iconUrl} alt="" className="h-3/4 w-3/4" />
		</span>
	);
}

/** Reload and the row's own close; the close shows on hover and focus, and always on touch screens. */
function Actions() {
	return (
		<span className="flex shrink-0 items-center gap-1">
			<button type="button" className={TOAST_ACTION_CLASS} onClick={reloadToNewVersion}>
				Reload
			</button>
			<button
				type="button"
				aria-label="Dismiss"
				className="shrink-0 rounded-md p-1 text-neutral-500 opacity-0 hover:bg-neutral-200 hover:text-neutral-900 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 group-hover:opacity-100 pointer-coarse:opacity-100"
				onClick={dismissUpdateNotice}
			>
				<X className="h-4 w-4" aria-hidden="true" />
			</button>
		</span>
	);
}

const ROW_CLASS = "group relative mx-2 rounded-lg bg-blue-50";

/**
 * "Kite was updated" as the first row of a message list, styled like mail but never part of it: it has no
 * `data-message-row`, so selection, j/k, bulk actions and counts skip it. Only its Reload button reloads the page, so a click on the row cannot lose an open draft.
 */
export function UpdateNoticeRow({ compact, density = "default" }: { compact: boolean; density?: MessageListDensity }) {
	const notice = useUpdateNotice();
	if (chooseUpdateSurface(notice) !== "row") return null;
	if (compact) {
		return (
			<div
				role="listitem"
				data-update-notice=""
				className={clsx(
					ROW_CLASS,
					"grid grid-cols-[36px_minmax(0,1fr)] items-center gap-x-3 px-3",
					getStackedRowDensity(density).rowClassName,
				)}
			>
				<Logo className="h-9 w-9 self-start" />
				<span className="block min-w-0">
					<span className="flex items-center justify-between gap-2">
						<span className="truncate text-sm font-semibold text-neutral-900">{SENDER}</span>
						<Actions />
					</span>
					<span className="mt-0.5 block truncate text-sm text-neutral-700">{UPDATE_ROW_SUBJECT}</span>
					<span className="mt-0.5 block truncate text-xs text-neutral-500">{UPDATE_ROW_PREVIEW}</span>
				</span>
			</div>
		);
	}
	return (
		<div
			role="listitem"
			data-update-notice=""
			className={clsx(
				ROW_CLASS,
				"grid grid-cols-[24px_32px_28px_minmax(140px,240px)_1fr_auto] items-center gap-3 px-4 text-sm",
				getWideRowDensity(density).rowClassName,
			)}
		>
			<span className="col-start-3">
				<Logo className="h-7 w-7" />
			</span>
			<span className="truncate font-semibold text-neutral-900">{SENDER}</span>
			<span className="min-w-0 truncate text-neutral-700">
				<span className="font-medium text-neutral-900">{UPDATE_ROW_SUBJECT}</span>
				<span className="text-neutral-500"> - {UPDATE_ROW_PREVIEW}</span>
			</span>
			<Actions />
		</div>
	);
}
