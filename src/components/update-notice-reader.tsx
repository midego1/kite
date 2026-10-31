"use client";

import { useEffect, useRef } from "react";
import { ArrowLeft, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useMessageListVisibility } from "@/components/messages/message-list-visibility";
import { BUILD_VERSION } from "@/lib/build-version";
import { changelogReleaseLabel } from "@/lib/changelog/changelog-utils";
import type { ChangelogRelease } from "@/lib/changelog/types";
import { formatUserDate } from "@/lib/time/utils";
import { InlineText } from "./changelog-inline-text";
import { updateSubject } from "./update-available-utils";
import { UPDATE_SENDER, UpdateSenderAvatar } from "./update-notice-row";
import { closeUpdateReader, dismissUpdateNotice, useRegisterUpdateList, useUpdateNotice } from "./update-notice-store";
import { reloadToNewVersion } from "./update-reload";

function ReleaseBody({ release }: { release: ChangelogRelease }) {
	const headingId = `update-notes-${release.name.replace(/[^\w-]/g, "-")}`;
	return (
		<section aria-labelledby={headingId} className="space-y-3">
			<h2 id={headingId} className="flex items-baseline gap-2 text-base font-semibold text-neutral-900">
				{changelogReleaseLabel(release)}
				{release.date && <span className="text-xs font-normal text-neutral-500">{release.date}</span>}
			</h2>
			{release.sections.map((section) => (
				<div key={section.title} className="space-y-1.5">
					<h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{section.title}</h3>
					<ul className="space-y-1.5">
						{section.items.map((item, index) => (
							<li key={`${section.title}:${index}`} className="flex gap-2 text-sm leading-relaxed text-neutral-800">
								<span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-blue-400" />
								<span className="min-w-0 break-words">
									<InlineText text={item} onNavigate={closeUpdateReader} />
								</span>
							</li>
						))}
					</ul>
				</div>
			))}
		</section>
	);
}

/**
 * "What's new" opened from the "Kite was updated" row, shown in the reader like an opened message from Kite: the
 * subject, the sender with the time the update was noticed, then the release notes the new server sent as the body,
 * with Reload and Dismiss under them. On a phone it takes the screen and Back returns to the list.
 */
export function UpdateNoticeReader() {
	const notice = useUpdateNotice();
	const { singleColumn, backLabel } = useMessageListVisibility();
	const headingRef = useRef<HTMLHeadingElement>(null);
	// While it is on screen it carries the notice, as a list does, so a phone showing only the reader gets no toast.
	useRegisterUpdateList(true);
	useEffect(() => {
		headingRef.current?.focus({ preventScroll: true });
	}, []);

	const headerLabel = singleColumn ? `Back to ${backLabel}` : "Close";
	const subject = updateSubject(notice.details);
	const { release, notes } = notice.details;
	const detected = notice.detectedAt === null ? null : new Date(notice.detectedAt).toISOString();
	return (
		<article aria-labelledby="update-notice-subject" data-update-reader="" className="flex h-full min-h-0 flex-col">
			<div className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-1 border-b border-neutral-200 bg-white px-3">
				{/* On a phone the reader is the whole screen and this goes back to the list; beside the list it closes. */}
				<Tooltip label={headerLabel}>
					<button
						type="button"
						className="relative z-10 shrink-0 rounded-full p-2 text-neutral-600 duration-200 hover:bg-neutral-100 hover:text-neutral-900"
						onClick={closeUpdateReader}
						aria-label={headerLabel}
					>
						{singleColumn ? <ArrowLeft size={18} aria-hidden="true" /> : <X size={18} aria-hidden="true" />}
					</button>
				</Tooltip>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-gutter-stable">
				<div className="px-4 pb-5 pt-5 sm:px-7">
					<h1
						ref={headingRef}
						id="update-notice-subject"
						tabIndex={-1}
						className="reading-font min-w-0 rounded-sm text-xl font-medium text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
					>
						{subject}
					</h1>
				</div>
				<div className="border-t border-neutral-200 px-4 py-6 sm:px-7">
					<div className="flex items-start justify-between gap-3 pb-5">
						<div className="flex min-w-0 items-center gap-3">
							<UpdateSenderAvatar className="h-9 w-9" />
							<p className="text-sm text-neutral-900">
								<b>{UPDATE_SENDER}</b>
							</p>
						</div>
						{detected && (
							<time dateTime={detected} className="shrink-0 pt-1 text-xs text-neutral-500">
								{formatUserDate(detected, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
							</time>
						)}
					</div>
					<div className="reading-font max-w-[640px] space-y-6">
						<div className="space-y-2 text-sm leading-relaxed text-neutral-800">
							<p>
								{release ? `Kite ${release} is live.` : "A new version of Kite is live."} Reload to get the latest
								version.
							</p>
							<p className="text-neutral-500">This tab runs Kite {BUILD_VERSION}.</p>
						</div>
						{notes.length > 0 ? (
							notes.map((entry) => <ReleaseBody key={entry.name} release={entry} />)
						) : (
							<p className="text-sm text-neutral-500">
								The release notes come with the new version: after reloading, open What&apos;s new in Kite from the
								version in the sidebar.
							</p>
						)}
						<div className="flex flex-wrap gap-2 pt-2">
							<Button type="button" onClick={reloadToNewVersion}>
								<RotateCw className="h-4 w-4" aria-hidden="true" />
								Reload
							</Button>
							<Button type="button" variant="outline" onClick={dismissUpdateNotice}>
								Dismiss
							</Button>
						</div>
					</div>
				</div>
			</div>
		</article>
	);
}
