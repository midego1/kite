import { SOURCE_CODE_URL } from "@/lib/source-code";
import { UPSTREAM_URL, featureThemes, footerLinks } from "./utils";
import { PAGE_X, HomeSection, textLink } from "./home-ui";
import type { HomeSectionProps } from "./types";

/** The feature list: one hairline row per theme, the title on the left, a sentence and its points on the right. */
export function HomeFeatures() {
	return (
		<HomeSection
			id="features"
			headingId="home-features-heading"
			title="Six parts. All of them included."
			intro="Each one is in the app today. None of it needs a plan, a seat or a license key."
		>
			<ul className="border-b border-(--home-line)">
				{featureThemes.map((theme) => (
					<li
						key={theme.id}
						id={`feature-${theme.id}`}
						className="grid gap-4 border-t border-(--home-line) py-8 first:border-t-0 first:pt-0 md:grid-cols-12 md:gap-8"
					>
						<h3 className="text-xl font-medium leading-tight tracking-[-0.02em] md:col-span-5 md:text-2xl">
							{theme.title}
						</h3>
						<div className="md:col-span-7">
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

export function HomeFooter({ appName }: HomeSectionProps) {
	return (
		<footer className="border-t border-(--home-line)">
			<div
				className={`${PAGE_X} flex flex-col gap-6 py-10 text-sm text-(--home-mute) lg:flex-row lg:items-center lg:justify-between`}
			>
				<p>
					{appName} is free software under the AGPL-3.0. Based on{" "}
					<a href={UPSTREAM_URL} target="_blank" rel="noopener noreferrer" className={textLink}>
						Mailflare
					</a>{" "}
					by hieunc229.
				</p>
				<nav aria-label="Project links" className="flex flex-wrap gap-x-6 gap-y-2">
					{footerLinks.map((link) => (
						<a
							key={link.href}
							href={link.href}
							target="_blank"
							rel="noopener noreferrer"
							className="transition-colors hover:text-(--home-ink)"
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
