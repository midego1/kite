"use client";

import { useMemo, useState } from "react";
import { splitChangelogImages } from "@/lib/changelog/changelog-image-utils";
import type { ChangelogRelease } from "@/lib/changelog/types";
import { ChangelogLightbox, ChangelogThumbnails, useShowChangelogImages } from "./changelog-images";
import { InlineText } from "./changelog-inline-text";

/**
 * The `###` groups of one release with their bullets, each followed by its screenshots as thumbnails unless
 * "Show images" is off. The dialog and the "Kite was updated" reader share it; they differ only in the heading
 * tag and the text colour.
 */
export function ChangelogSections({
	release,
	onNavigate,
	titleAs: Title,
	textClassName,
}: {
	release: ChangelogRelease;
	onNavigate: () => void;
	titleAs: "p" | "h3";
	textClassName: string;
}) {
	const [showImages] = useShowChangelogImages();
	const [open, setOpen] = useState<number | null>(null);
	const parsed = useMemo(
		() => release.sections.map((section) => section.items.map((item) => splitChangelogImages(item))),
		[release],
	);
	// The viewer steps through every screenshot of the release, in the order they appear.
	const images = useMemo(() => parsed.flat().flatMap((item) => item.images), [parsed]);
	// Where each note's screenshots start in that list.
	const firstIndexes = useMemo(() => {
		const firsts: number[][] = [];
		let next = 0;
		for (const items of parsed) {
			const row: number[] = [];
			for (const item of items) {
				row.push(next);
				next += item.images.length;
			}
			firsts.push(row);
		}
		return firsts;
	}, [parsed]);

	return (
		<>
			{release.sections.map((section, sectionIndex) => (
				<div key={`${section.title}:${sectionIndex}`} className="space-y-1.5">
					<Title className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{section.title}</Title>
					<ul className="space-y-1.5">
						{parsed[sectionIndex].map(({ text, images: itemImages }, index) => {
							const firstIndex = firstIndexes[sectionIndex][index];
							return (
								<li key={`${section.title}:${index}`} className={`flex gap-2 text-sm leading-relaxed ${textClassName}`}>
									<span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-blue-400" />
									<span className="min-w-0 break-words">
										<InlineText text={text} onNavigate={onNavigate} />
										{showImages && itemImages.length > 0 && (
											<ChangelogThumbnails
												scope={release.name}
												images={itemImages}
												firstIndex={firstIndex}
												onOpen={setOpen}
											/>
										)}
									</span>
								</li>
							);
						})}
					</ul>
				</div>
			))}
			{showImages && (
				<ChangelogLightbox
					scope={release.name}
					images={images}
					index={open}
					onIndexChange={setOpen}
					onClose={() => setOpen(null)}
				/>
			)}
		</>
	);
}
