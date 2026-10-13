"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BUILD_VERSION_LABEL } from "@/lib/build-version";
import { changelogReleaseLabel, isAppChangelogHref, parseInlineMarkdown } from "@/lib/changelog/changelog-utils";
import type { ChangelogInline, ChangelogRelease } from "@/lib/changelog/types";

const LINK_CLASS = "text-blue-700 underline underline-offset-2 hover:text-blue-800";

function InlineToken({ token, onNavigate }: { token: ChangelogInline; onNavigate: () => void }) {
	if (token.type === "code") {
		return (
			<code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[12px] text-neutral-800">{token.text}</code>
		);
	}
	if (token.type === "strong") return <strong className="font-semibold text-neutral-900">{token.text}</strong>;
	if (token.type === "link") {
		// A link into the app (for example the setting a note talks about) opens
		// in this tab and closes the dialog; outside links open in a new tab.
		if (isAppChangelogHref(token.href)) {
			return (
				<Link href={token.href} className={LINK_CLASS} onClick={onNavigate}>
					{token.text}
				</Link>
			);
		}
		return (
			<a href={token.href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
				{token.text}
			</a>
		);
	}
	return token.text;
}

/** Every changelog item is written as text nodes, so nothing in the file can become markup. */
function InlineText({ text, onNavigate }: { text: string; onNavigate: () => void }) {
	return parseInlineMarkdown(text).map((token, index) => (
		<InlineToken key={index} token={token} onNavigate={onNavigate} />
	));
}

function ReleaseNotes({ release, onNavigate }: { release: ChangelogRelease; onNavigate: () => void }) {
	return (
		<section className="space-y-3">
			<div className="sticky top-0 flex items-baseline gap-2 bg-white py-1">
				<h3 className="text-sm font-semibold text-neutral-900">{changelogReleaseLabel(release)}</h3>
				{release.date && <span className="text-xs text-neutral-500">{release.date}</span>}
			</div>
			{release.sections.map((section) => (
				<div key={section.title} className="space-y-1.5">
					<p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{section.title}</p>
					<ul className="space-y-1.5">
						{section.items.map((item, index) => (
							<li key={`${section.title}:${index}`} className="flex gap-2 text-sm leading-relaxed text-neutral-700">
								<span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-blue-400" />
								<span className="min-w-0 break-words">
									<InlineText text={item} onNavigate={onNavigate} />
								</span>
							</li>
						))}
					</ul>
				</div>
			))}
		</section>
	);
}

export function ChangelogDialog({
	open,
	onOpenChange,
	updatedLabel,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The formatted build time, or null while the footer has not read the browser's locale yet. */
	updatedLabel: string | null;
}) {
	const [releases, setReleases] = useState<ChangelogRelease[] | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		if (!open || releases || typeof window === "undefined") return;
		let active = true;
		void import("@/lib/changelog/changelog-bundle")
			.then((module) => {
				if (active) setReleases(module.loadChangelogReleases());
			})
			.catch(() => {
				if (active) setFailed(true);
			});
		return () => {
			active = false;
		};
	}, [open, releases]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="w-[min(680px,calc(100vw-32px))] max-h-[calc(100vh-4rem)] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>What&apos;s new in Kite</DialogTitle>
					<DialogDescription>
						{`Kite v${BUILD_VERSION_LABEL}`}
						{updatedLabel ? ` · Updated ${updatedLabel}` : ""}
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-6">
					{!releases && !failed && <p className="text-sm text-neutral-500">Loading release notes…</p>}
					{failed && <p className="text-sm text-neutral-500">Could not load the release notes.</p>}
					{releases?.length === 0 && <p className="text-sm text-neutral-500">No release notes yet.</p>}
					{releases?.map((release) => (
						<ReleaseNotes key={release.name} release={release} onNavigate={() => onOpenChange(false)} />
					))}
				</div>
			</DialogContent>
		</Dialog>
	);
}
