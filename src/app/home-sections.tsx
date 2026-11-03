import { SOURCE_CODE_URL } from "@/lib/source-code";
import { UPSTREAM_URL, featureThemes, footerLinks } from "./utils";
import { HomeSection, MONO, PAD, textLink } from "./home-ui";
import type { HomeSectionProps } from "./types";

/** A numbered balloon, as a drawing marks a part. */
export function Balloon({ n }: { n: number }) {
	return (
		<span
			aria-hidden="true"
			className={`${MONO} flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-(--home-line-strong) text-(--home-mute)`}
		>
			{n}
		</span>
	);
}

/** The parts list: one hairline row per theme, a balloon number, the part, then what it does and its details. */
export function HomeFeatures() {
	return (
		<HomeSection
			id="features"
			headingId="home-features-heading"
			title="Six parts. All of them included."
			intro="Each one is in the app today. None of it needs a plan, a seat or a license key."
		>
			<div
				aria-hidden="true"
				className={`${MONO} hidden grid-cols-[2.25rem_minmax(0,1fr)_minmax(0,1.5fr)] gap-x-4 pb-3 text-(--home-dim) md:grid`}
			>
				<span>Item</span>
				<span>Part</span>
				<span>Description</span>
			</div>
			<ul className="border-b border-(--home-line)">
				{featureThemes.map((theme, index) => (
					<li
						key={theme.id}
						id={`feature-${theme.id}`}
						className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-4 gap-y-3 border-t border-(--home-line) py-8 md:grid-cols-[2.25rem_minmax(0,1fr)_minmax(0,1.5fr)]"
					>
						<Balloon n={index + 1} />
						<h3 className="text-xl font-medium leading-tight tracking-[-0.02em] md:text-2xl">{theme.title}</h3>
						<div className="col-start-2 md:col-start-3">
							<p className="text-pretty text-base leading-7 text-(--home-ink)">{theme.summary}</p>
							<ul className="mt-3 space-y-2">
								{theme.points.map((point) => (
									<li key={point} className="text-pretty text-[15px] leading-6 text-(--home-mute)">
										{point}
									</li>
								))}
							</ul>
						</div>
					</li>
				))}
			</ul>
		</HomeSection>
	);
}

/** The footer is the sheet's title block: ruled cells for the licence line and the project links. */
export function HomeFooter({ appName }: HomeSectionProps) {
	return (
		<footer className="relative border-t border-(--home-line-strong)">
			<div className="grid text-sm text-(--home-mute) lg:grid-cols-12">
				<p className={`${PAD} py-8 lg:col-span-6 lg:border-r lg:border-(--home-line)`}>
					{appName} is free software under the AGPL-3.0. Based on{" "}
					<a href={UPSTREAM_URL} target="_blank" rel="noopener noreferrer" className={textLink}>
						Mailflare
					</a>{" "}
					by hieunc229.
				</p>
				<nav
					aria-label="Project links"
					className={`${PAD} flex flex-wrap gap-x-6 gap-y-2 border-t border-(--home-line) py-8 lg:col-span-6 lg:border-t-0`}
				>
					{footerLinks.map((link) => (
						<a
							key={link.href}
							href={link.href}
							target="_blank"
							rel="noopener noreferrer"
							className="py-1 transition-colors hover:text-(--home-ink)"
							{...(link.href === SOURCE_CODE_URL ? { "data-source-link": "" } : {})}
						>
							{link.label}
						</a>
					))}
				</nav>
			</div>
		</footer>
	);
}
