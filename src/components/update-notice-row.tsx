"use client";

import clsx from "clsx";
import { RotateCw, X } from "lucide-react";
import { useBranding } from "@/components/branding-provider";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { getStackedRowDensity, getWideRowDensity } from "@/components/messages/reading-layout-utils";
import type { MessageListDensity } from "@/components/messages/reading-layout-types";
import { formatMessageListTimestamp } from "@/components/messages/utils";
import { chooseUpdateSurface, updatePreview, updateSubject } from "./update-available-utils";
import type { UpdateNoticeState } from "./update-available-types";
import { dismissUpdateNotice, openUpdateReader, useUpdateNotice, useUpdateReaderHost } from "./update-notice-store";
import { reloadToNewVersion } from "./update-reload";

export const UPDATE_SENDER = "Kite";

/** The Kite logo in the round avatar a sender gets. */
export function UpdateSenderAvatar({ className }: { className: string }) {
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

/**
 * Reload and Dismiss as row actions, like a message's: a small pill that shows on hover and keyboard focus.
 * Touch screens have no hover, so there it always shows, at the end of the preview line where it leaves the time be.
 */
function Actions({ compact }: { compact: boolean }) {
	const buttonClassName = compact ? "h-[22px] w-6 rounded p-0" : undefined;
	return (
		<div
			className={clsx(
				"absolute z-10 flex items-center gap-1 opacity-0 transition-opacity pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100",
				compact
					? "-right-1 -top-1.5 h-6 gap-0 rounded-md border border-neutral-200 bg-white shadow-sm pointer-coarse:-bottom-0.5 pointer-coarse:top-auto"
					: "right-6 top-1/2 -translate-y-1/2 bg-[#f2f6fc] pl-3",
			)}
		>
			<Tooltip label="Reload to get the latest version">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className={buttonClassName}
					onClick={reloadToNewVersion}
					aria-label="Reload"
				>
					<RotateCw className="h-4 w-4" aria-hidden="true" />
				</Button>
			</Tooltip>
			<Tooltip label="Dismiss">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className={buttonClassName}
					onClick={dismissUpdateNotice}
					aria-label="Dismiss"
				>
					<X className="h-4 w-4" aria-hidden="true" />
				</Button>
			</Tooltip>
		</div>
	);
}

/**
 * The part of the row that opens "What's new" in the reader. Lists without a reader (Drafts) leave it plain text.
 * Its name is set, so the preview's "Reload" never makes it a second Reload button.
 */
function Opener({
	notice,
	subject,
	className,
	children,
}: {
	notice: UpdateNoticeState;
	subject: string;
	className: string;
	children: React.ReactNode;
}) {
	const hosted = useUpdateReaderHost();
	if (!hosted) return <span className={className}>{children}</span>;
	return (
		<button
			type="button"
			onClick={openUpdateReader}
			aria-current={notice.open ? "true" : undefined}
			aria-label={`${notice.read ? "" : "Unread, "}${subject}, from ${UPDATE_SENDER}. Open what's new`}
			className={clsx("text-left", className)}
		>
			{children}
		</button>
	);
}

function Time({ notice, className }: { notice: UpdateNoticeState; className: string }) {
	if (notice.detectedAt === null) return null;
	const iso = new Date(notice.detectedAt).toISOString();
	return (
		<time dateTime={iso} className={className}>
			{formatMessageListTimestamp(iso)}
		</time>
	);
}

/**
 * "Kite was updated" as the first row of a message list, drawn like a message from Kite but never one: it has no
 * `data-message-row`, so selection, j/k, bulk actions and counts skip it, and it reads as read once opened. A
 * click opens "What's new" in the reader (MessageSplitLayout), never a reload, so a click cannot lose an open draft.
 */
export function UpdateNoticeRow({ compact, density = "default" }: { compact: boolean; density?: MessageListDensity }) {
	const notice = useUpdateNotice();
	if (chooseUpdateSurface(notice) !== "row") return null;
	const subject = updateSubject(notice.details);
	const preview = updatePreview(notice.details);
	const unread = !notice.read;
	if (compact) {
		const stackedDensity = getStackedRowDensity(density);
		return (
			<div
				role="listitem"
				data-update-notice=""
				className={clsx(
					"group relative mx-2 grid grid-cols-[36px_minmax(0,1fr)] items-center gap-x-3 rounded-lg px-3 transition-colors",
					stackedDensity.rowClassName,
					notice.open ? "bg-neutral-100" : "hover:bg-neutral-100/60",
				)}
			>
				<span className="relative h-9 w-9 self-start">
					<UpdateSenderAvatar className="h-9 w-9" />
					{unread && (
						<span
							aria-hidden="true"
							className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-blue-500 ring-2 ring-[var(--color-white)]"
						/>
					)}
				</span>
				<div className="relative min-w-0">
					<Opener
						notice={notice}
						subject={subject}
						className="block w-full min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
					>
						<span className="flex items-baseline justify-between gap-3">
							<span
								className={clsx(
									"reading-font min-w-0 truncate text-sm",
									unread ? "font-bold text-neutral-900" : "text-neutral-800",
								)}
							>
								{UPDATE_SENDER}
							</span>
							<Time
								notice={notice}
								className="shrink-0 text-xs text-neutral-500 pointer-fine:group-hover:invisible pointer-fine:group-has-[:focus-visible]:invisible"
							/>
						</span>
						<span
							className={clsx(
								"reading-font mt-0.5 block truncate text-sm",
								unread ? "text-neutral-700" : "text-neutral-500",
							)}
						>
							{subject}
						</span>
						{stackedDensity.showPreview && (
							<span className="reading-font mt-0.5 block truncate text-xs text-neutral-500 pointer-coarse:pr-14">
								{preview}
							</span>
						)}
					</Opener>
					<Actions compact />
				</div>
			</div>
		);
	}
	return (
		<div
			role="listitem"
			data-update-notice=""
			className={clsx(
				"group relative mx-2 grid grid-cols-[24px_32px_28px_minmax(140px,240px)_1fr_auto] items-center gap-3 rounded-lg px-4 text-left text-sm hover:z-10 has-[button:focus-visible]:ring-2 has-[button:focus-visible]:ring-inset has-[button:focus-visible]:ring-blue-600",
				getWideRowDensity(density).rowClassName,
				notice.open ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-neutral-100/70",
			)}
		>
			<span className="col-start-3">
				<UpdateSenderAvatar className="h-7 w-7" />
			</span>
			<span className="flex min-w-0 items-center gap-1.5">
				<span className={clsx("reading-font truncate", unread ? "font-bold text-neutral-900" : "text-neutral-800")}>
					{UPDATE_SENDER}
				</span>
				<span
					aria-hidden="true"
					className={clsx("h-2 w-2 shrink-0 rounded-full", unread ? "bg-blue-500" : "bg-transparent")}
				/>
			</span>
			<span className="min-w-0 truncate text-neutral-700">
				{/* As in a message row, the opener stretches over the whole row; the actions sit above it. */}
				<Opener notice={notice} subject={subject} className="after:absolute after:inset-0 focus-visible:outline-none">
					<span className={clsx("reading-font", unread && "font-medium text-neutral-900")}>{subject}</span>
					<span className="reading-font text-neutral-500"> - {preview}</span>
				</Opener>
			</span>
			<span className="flex min-w-[96px] justify-end group-hover:opacity-0 pointer-coarse:opacity-0">
				<Time
					notice={notice}
					className={clsx(
						"whitespace-nowrap text-right text-xs",
						unread ? "font-medium text-neutral-900" : "text-neutral-500",
					)}
				/>
			</span>
			<Actions compact={false} />
		</div>
	);
}
