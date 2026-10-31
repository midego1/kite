"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { BUILD_VERSION, BUILD_VERSION_LABEL } from "@/lib/build-version";
import {
	EAGER_RELEASE_COUNT,
	estimateReleaseHeight,
	initialReleaseName,
	isCurrentRelease,
	nextNavIndex,
	pickActiveRelease,
	releaseAnchorId,
	visibleReleases,
} from "@/lib/changelog/changelog-nav-utils";
import { changelogReleaseLabel, parseChangelog } from "@/lib/changelog/changelog-utils";
import type { ChangelogRelease } from "@/lib/changelog/types";
import { InlineText } from "./changelog-inline-text";

function ReleaseNotes({ release, onNavigate }: { release: ChangelogRelease; onNavigate: () => void }) {
	return (
		<>
			<div className="sticky top-0 z-10 flex items-baseline gap-2 bg-white py-1">
				<h3
					id={releaseAnchorId(release)}
					tabIndex={-1}
					className="text-sm font-semibold text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
				>
					{changelogReleaseLabel(release)}
				</h3>
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
		</>
	);
}

/** One list entry in the sidebar: the version, its date and a mark on the release this build is running. */
function ReleaseNavItem({
	release,
	active,
	current,
	onSelect,
}: {
	release: ChangelogRelease;
	active: boolean;
	current: boolean;
	onSelect: () => void;
}) {
	const unreleased = release.name === "Unreleased";
	return (
		<button
			type="button"
			data-release-nav={release.name}
			aria-current={active ? "location" : undefined}
			onClick={onSelect}
			className={`flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
				active
					? "bg-neutral-100 font-medium text-neutral-900"
					: "text-neutral-600 hover:bg-neutral-100/70 hover:text-neutral-900"
			}`}
		>
			<span className="flex w-full items-center justify-between gap-2">
				<span className="truncate">{unreleased ? "Unreleased" : release.name}</span>
				{current && (
					<span className="shrink-0 rounded-full border border-neutral-300 px-1.5 text-[10px] font-medium uppercase tracking-wide text-neutral-600">
						Current
					</span>
				)}
			</span>
			<span className="text-xs font-normal text-neutral-500">
				{release.date ?? (unreleased ? "Not released yet" : "")}
			</span>
		</button>
	);
}

type Jump = { name: string; seq: number; smooth: boolean; focus: boolean };

/** Keep a jump from being undone by the highlight while the scroll is still travelling. */
const JUMP_LOCK_MS = 800;

/**
 * The release list and the notes beside it. Notes beyond the first few are drawn only when they near
 * the viewport (or when a jump needs them), and the highlighted release follows the scroll.
 */
function ChangelogReader({ releases, onNavigate }: { releases: ChangelogRelease[]; onNavigate: () => void }) {
	const shown = useMemo(() => visibleReleases(releases), [releases]);
	const names = useMemo(() => shown.map((release) => release.name), [shown]);
	const scrollRef = useRef<HTMLDivElement>(null);
	const navRef = useRef<HTMLUListElement>(null);
	const lockedUntil = useRef(0);
	const intersecting = useRef(new Set<string>());
	const activeRef = useRef<string | null>(null);
	const [eagerCount, setEagerCount] = useState(() =>
		Math.max(EAGER_RELEASE_COUNT, names.indexOf(initialReleaseName(shown, BUILD_VERSION) ?? "") + 1),
	);
	const [drawn, setDrawn] = useState<ReadonlySet<string>>(() => new Set());
	const [active, setActiveState] = useState<string | null>(() => initialReleaseName(shown, BUILD_VERSION));
	const [jump, setJump] = useState<Jump | null>(() => {
		const first = initialReleaseName(shown, BUILD_VERSION);
		return first && first !== shown[0]?.name ? { name: first, seq: 0, smooth: false, focus: false } : null;
	});

	const setActive = useCallback((name: string | null) => {
		activeRef.current = name;
		setActiveState(name);
	}, []);

	// Draw every note above the target first, so nothing above it changes height while the scroll travels.
	const goTo = useCallback(
		(name: string) => {
			const index = names.indexOf(name);
			if (index < 0) return;
			setEagerCount((count) => Math.max(count, index + 1));
			lockedUntil.current = Date.now() + JUMP_LOCK_MS;
			setActive(name);
			const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			setJump((previous) => ({ name, seq: (previous?.seq ?? 0) + 1, smooth, focus: true }));
		},
		[names, setActive],
	);

	useEffect(() => {
		if (!jump) return;
		const heading = document.getElementById(releaseAnchorId({ name: jump.name }));
		const container = scrollRef.current;
		if (!heading || !container) return;
		const section = heading.closest("[data-release]") ?? heading;
		container.scrollTo({
			top: Math.max(
				0,
				section.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop,
			),
			behavior: jump.smooth ? "smooth" : "auto",
		});
		if (!jump.focus) return;
		// A closing menu hands focus back to its trigger a moment later, so the heading takes it after that.
		const timer = window.setTimeout(() => heading.focus({ preventScroll: true }), 60);
		return () => window.clearTimeout(timer);
	}, [jump]);

	// Draw a note once it is within a screen of the viewport; drawn notes stay drawn.
	useEffect(() => {
		const container = scrollRef.current;
		if (!container) return;
		const observer = new IntersectionObserver(
			(entries) => {
				const visible = entries
					.filter((entry) => entry.isIntersecting)
					.map((entry) => (entry.target as HTMLElement).dataset.release!);
				if (visible.length === 0) return;
				setDrawn((previous) => new Set([...previous, ...visible]));
			},
			{ root: container, rootMargin: "0px 0px 800px 0px" },
		);
		for (const element of container.querySelectorAll<HTMLElement>("[data-undrawn]")) observer.observe(element);
		return () => observer.disconnect();
	}, [eagerCount, drawn]);

	// The highlighted release is the topmost one that reaches the upper part of the pane.
	useEffect(() => {
		const container = scrollRef.current;
		if (!container) return;
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const name = (entry.target as HTMLElement).dataset.release!;
					if (entry.isIntersecting) intersecting.current.add(name);
					else intersecting.current.delete(name);
				}
				if (Date.now() < lockedUntil.current) return;
				const next = pickActiveRelease(names, intersecting.current, activeRef.current);
				if (next !== activeRef.current) setActive(next);
			},
			{ root: container, rootMargin: "0px 0px -70% 0px" },
		);
		for (const element of container.querySelectorAll<HTMLElement>("[data-release]")) observer.observe(element);
		const seen = intersecting.current;
		return () => {
			observer.disconnect();
			seen.clear();
		};
	}, [names, setActive]);

	// Keep the highlighted entry in view when the notes scroll a long list.
	useEffect(() => {
		if (!active) return;
		navRef.current
			?.querySelector<HTMLElement>(`[data-release-nav="${CSS.escape(active)}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [active]);

	const onNavKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
		const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
		const index = buttons.findIndex((button) => button === document.activeElement);
		if (index < 0) return;
		const next = nextNavIndex(event.key, index, buttons.length);
		if (next === null) return;
		event.preventDefault();
		buttons[next].focus();
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col md:flex-row">
			<nav
				aria-label="Releases"
				className="hidden w-56 shrink-0 border-r border-neutral-200 md:block md:overflow-y-auto"
			>
				<ul ref={navRef} onKeyDown={onNavKeyDown} className="space-y-0.5 p-3">
					{shown.map((release) => (
						<li key={release.name}>
							<ReleaseNavItem
								release={release}
								active={release.name === active}
								current={isCurrentRelease(release, BUILD_VERSION)}
								onSelect={() => goTo(release.name)}
							/>
						</li>
					))}
				</ul>
			</nav>
			<div className="shrink-0 border-b border-neutral-200 px-4 py-3 md:hidden">
				<Select
					aria-label="Jump to release"
					value={active ?? ""}
					onChange={(event) => goTo(event.target.value)}
					containerClassName="w-full"
					className="text-sm"
				>
					{shown.map((release) => (
						<option key={release.name} value={release.name}>
							{release.name === "Unreleased" ? "Unreleased" : release.name}
							{release.date ? ` · ${release.date}` : ""}
							{isCurrentRelease(release, BUILD_VERSION) ? " · Current" : ""}
						</option>
					))}
				</Select>
			</div>
			<div ref={scrollRef} data-testid="changelog-notes" className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
				{shown.map((release, index) => {
					const lazy = index >= eagerCount && !drawn.has(release.name);
					return (
						<section
							key={release.name}
							data-release={release.name}
							data-undrawn={lazy ? "" : undefined}
							aria-labelledby={lazy ? undefined : releaseAnchorId(release)}
							style={lazy ? { minHeight: estimateReleaseHeight(release) } : undefined}
							className="space-y-3 pt-2 pb-5"
						>
							{lazy ? (
								<p className="py-1 text-sm font-semibold text-neutral-500">{changelogReleaseLabel(release)}</p>
							) : (
								<ReleaseNotes release={release} onNavigate={onNavigate} />
							)}
						</section>
					);
				})}
			</div>
		</div>
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
		// The release notes are a static asset (`scripts/generate-changelog-bundle.mjs`), fetched only when
		// the dialog first opens so they never weigh on the page's JavaScript.
		void fetch("/changelog.json", { cache: "no-cache" })
			.then(async (response) => {
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const { markdown } = (await response.json()) as { markdown: string };
				if (active) setReleases(parseChangelog(markdown));
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
			<DialogContent
				overlayClassName="z-[120]"
				className="z-[120] flex h-[calc(100vh-4rem)] max-h-[44rem] w-[min(56rem,calc(100vw-32px))] flex-col gap-0 overflow-hidden p-0"
			>
				<DialogHeader className="mb-0 shrink-0 border-b border-neutral-200 px-6 py-4 pr-12">
					<DialogTitle>What&apos;s new in Kite</DialogTitle>
					<DialogDescription>
						{`Kite v${BUILD_VERSION_LABEL}`}
						{updatedLabel ? ` · Updated ${updatedLabel}` : ""}
					</DialogDescription>
				</DialogHeader>
				{!releases && !failed && <p className="p-6 text-sm text-neutral-500">Loading release notes…</p>}
				{failed && <p className="p-6 text-sm text-neutral-500">Could not load the release notes.</p>}
				{releases?.length === 0 && <p className="p-6 text-sm text-neutral-500">No release notes yet.</p>}
				{releases && releases.length > 0 && (
					<ChangelogReader releases={releases} onNavigate={() => onOpenChange(false)} />
				)}
			</DialogContent>
		</Dialog>
	);
}
