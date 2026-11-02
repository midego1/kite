"use client";

import { useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, Maximize2, Minimize2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useStoredState } from "@/hooks/use-stored-state";
import type { ChangelogImage } from "@/lib/changelog/types";

/** The "Show images" choice of the release notes, kept in this browser. On unless someone turned it off. */
const CHANGELOG_IMAGES_STORAGE_KEY = "kite-changelog-images";

export function useShowChangelogImages(): [boolean, (show: boolean) => void] {
	return useStoredState<boolean>(CHANGELOG_IMAGES_STORAGE_KEY, true);
}

/** Small screenshots under the note they belong to; each one opens the larger view. */
export function ChangelogThumbnails({
	scope,
	images,
	firstIndex,
	onOpen,
}: {
	/** Names the release, so thumbnails of two releases never share a key. */
	scope: string;
	images: ChangelogImage[];
	/** Index of the first image in the release's list, which the viewer steps through. */
	firstIndex: number;
	onOpen: (index: number) => void;
}) {
	return (
		<span className="mt-2 flex flex-wrap gap-2">
			{images.map((image, offset) => (
				<button
					key={`${image.src}:${offset}`}
					type="button"
					data-changelog-thumb={`${scope}:${firstIndex + offset}`}
					aria-haspopup="dialog"
					onClick={() => onOpen(firstIndex + offset)}
					className="block h-24 w-40 overflow-hidden rounded-lg border border-neutral-200 bg-neutral-100 transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 sm:h-28 sm:w-48"
				>
					{/* A fixed box keeps the notes from jumping when a lazy image arrives. */}
					{/* eslint-disable-next-line @next/next/no-img-element -- a static, same-origin screenshot */}
					<img
						src={image.src}
						alt={image.alt}
						loading="lazy"
						decoding="async"
						className="h-full w-full object-cover object-left-top"
					/>
				</button>
			))}
		</span>
	);
}

/**
 * The larger view of a release's screenshots. Escape closes it and the focus goes back to the thumbnail that
 * was last shown; the left and right arrow keys step through the release's images; "Actual size" swaps the
 * fit-to-screen view for the image's own pixels, scrolled inside the viewer.
 */
export function ChangelogLightbox({
	scope,
	images,
	index,
	onIndexChange,
	onClose,
}: {
	/** The release the screenshots belong to, as given to its thumbnails. */
	scope: string;
	images: ChangelogImage[];
	/** The image on show, or null while the viewer is closed. */
	index: number | null;
	onIndexChange: (index: number) => void;
	onClose: () => void;
}) {
	// The image that is shown at its own size; moving on to another one goes back to fit-to-screen.
	const [actualSizeIndex, setActualSizeIndex] = useState<number | null>(null);
	const image = index === null ? undefined : images[index];
	const actualSize = index !== null && actualSizeIndex === index;

	const step = (delta: number) => {
		if (index === null || images.length < 2) return;
		onIndexChange((index + delta + images.length) % images.length);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "ArrowLeft") step(-1);
		else if (event.key === "ArrowRight") step(1);
		else return;
		event.preventDefault();
	};

	return (
		<Dialog open={Boolean(image)} onOpenChange={(open) => !open && onClose()}>
			{image && index !== null && (
				<DialogContent
					overlayClassName="z-[130] bg-black/70"
					className="z-[130] flex max-h-[calc(100vh-2rem)] w-[min(72rem,calc(100vw-1rem))] flex-col gap-3 p-3 sm:p-4"
					onKeyDown={onKeyDown}
					onCloseAutoFocus={(event) => {
						// Back to the thumbnail that is showing now, not the one that opened the viewer.
						const thumbnail = document.querySelector<HTMLElement>(
							`[data-changelog-thumb="${CSS.escape(`${scope}:${index}`)}"]`,
						);
						if (thumbnail) {
							event.preventDefault();
							thumbnail.focus();
						}
					}}
				>
					<DialogTitle className="pr-8 text-sm font-medium">{image.alt}</DialogTitle>
					<DialogDescription className="sr-only">
						{`Screenshot ${index + 1} of ${images.length}. Use the left and right arrow keys for the other screenshots.`}
					</DialogDescription>
					<div
						data-testid="changelog-lightbox-stage"
						className={`min-h-0 flex-1 rounded-lg bg-neutral-100 ${actualSize ? "overflow-auto" : "flex items-center justify-center overflow-hidden"}`}
					>
						{/* eslint-disable-next-line @next/next/no-img-element -- a static, same-origin screenshot */}
						<img
							src={image.src}
							alt={image.alt}
							className={actualSize ? "max-w-none" : "max-h-[calc(100vh-11rem)] max-w-full object-contain"}
						/>
					</div>
					<div className="flex items-center justify-between gap-2">
						<button
							type="button"
							onClick={() => setActualSizeIndex(actualSize ? null : index)}
							aria-pressed={actualSize}
							className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
						>
							{actualSize ? (
								<Minimize2 className="h-4 w-4" aria-hidden="true" />
							) : (
								<Maximize2 className="h-4 w-4" aria-hidden="true" />
							)}
							{actualSize ? "Fit to screen" : "Actual size"}
						</button>
						{images.length > 1 && (
							<div className="flex items-center gap-1">
								<button
									type="button"
									onClick={() => step(-1)}
									aria-label="Previous image"
									className="rounded-md p-1.5 text-neutral-700 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
								>
									<ChevronLeft className="h-4 w-4" aria-hidden="true" />
								</button>
								<span aria-hidden="true" className="min-w-10 text-center text-xs text-neutral-500">
									{index + 1} / {images.length}
								</span>
								<button
									type="button"
									onClick={() => step(1)}
									aria-label="Next image"
									className="rounded-md p-1.5 text-neutral-700 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
								>
									<ChevronRight className="h-4 w-4" aria-hidden="true" />
								</button>
							</div>
						)}
					</div>
				</DialogContent>
			)}
		</Dialog>
	);
}
