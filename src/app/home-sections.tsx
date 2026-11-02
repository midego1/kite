import { Check } from "lucide-react";
import { SOURCE_CODE_URL } from "@/lib/source-code";
import { UPSTREAM_URL, featureThemes, footerLinks } from "./utils";
import type { HomeSectionProps } from "./types";

/** The feature grid: one card per theme, each a heading, one sentence and a short list. */
export function HomeFeatures({ appName }: HomeSectionProps) {
	return (
		<section
			id="features"
			aria-labelledby="home-features-heading"
			className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8"
		>
			<div className="mx-auto max-w-2xl text-center">
				<p className="text-sm font-semibold text-blue-700">What {appName} does today</p>
				<h2 id="home-features-heading" className="mt-2 text-3xl font-bold tracking-tight text-neutral-950 sm:text-4xl">
					Six parts. All of them included.
				</h2>
				<p className="mt-4 text-base leading-7 text-neutral-600">
					Each one is in the app today. None of it needs a plan, a seat or a license key.
				</p>
			</div>
			<ul className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
				{featureThemes.map((theme, index) => {
					const Icon = theme.icon;
					return (
						<li
							key={theme.id}
							id={`feature-${theme.id}`}
							className={`flex flex-col rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm shadow-neutral-200/40 ${
								theme.wide ? "xl:col-span-3" : ""
							}`}
						>
							<div className="flex items-center justify-between">
								<span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#eef3fb] text-blue-700">
									<Icon className="h-5 w-5" />
								</span>
								<span aria-hidden="true" className="text-sm font-semibold tabular-nums text-neutral-400">
									{String(index + 1).padStart(2, "0")}
								</span>
							</div>
							<h3 className="mt-4 text-lg font-semibold tracking-tight text-neutral-950">{theme.title}</h3>
							<p className="mt-2 text-sm leading-6 text-neutral-600">{theme.summary}</p>
							<ul
								className={`mt-4 space-y-2.5 ${theme.wide ? "xl:grid xl:grid-cols-2 xl:gap-x-8 xl:space-y-0 xl:gap-y-2.5" : ""}`}
							>
								{theme.points.map((point) => (
									<li key={point} className="flex gap-2.5 text-sm leading-6 text-neutral-700">
										<Check className="mt-1.5 h-3.5 w-3.5 shrink-0 text-blue-500" aria-hidden="true" />
										<span>{point}</span>
									</li>
								))}
							</ul>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

export function HomeFooter({ appName }: HomeSectionProps) {
	return (
		<footer className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-10 text-sm text-neutral-500 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
			<p>
				{appName} is free software under the AGPL-3.0. Based on{" "}
				<a href={UPSTREAM_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
					Mailflare
				</a>{" "}
				by hieunc229.
			</p>
			<nav aria-label="Project links" className="flex flex-wrap gap-x-5 gap-y-2">
				{footerLinks.map((link) => (
					<a
						key={link.href}
						href={link.href}
						target="_blank"
						rel="noopener noreferrer"
						className="underline-offset-4 hover:text-neutral-900 hover:underline"
						{...(link.href === SOURCE_CODE_URL ? { "data-source-link": "" } : {})}
					>
						{link.label}
					</a>
				))}
			</nav>
		</footer>
	);
}
