import { ArrowUpRight, Check } from "lucide-react";
import { SOURCE_CODE_URL } from "@/lib/source-code";
import { UPSTREAM_URL, featureThemes, footerLinks, runtimeCards } from "./utils";
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
					One quiet place for your mail and what comes with it.
				</h2>
				<p className="mt-4 text-base leading-7 text-neutral-600">
					Every part below is in the app now, documented and tested. Nothing here needs a plan, a seat or a key.
				</p>
			</div>
			<ul className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
				{featureThemes.map((theme) => {
					const Icon = theme.icon;
					return (
						<li
							key={theme.id}
							id={`feature-${theme.id}`}
							className={`flex flex-col rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm shadow-neutral-200/40 ${
								theme.wide ? "xl:col-span-3" : ""
							}`}
						>
							<span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#eef3fb] text-blue-700">
								<Icon className="h-5 w-5" />
							</span>
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

/** Where the app runs and under which license, with the three ways in. */
export function HomeRuntime({ appName }: HomeSectionProps) {
	return (
		<section
			id="how-it-runs"
			aria-labelledby="home-runtime-heading"
			className="border-y border-neutral-200 bg-white py-16"
		>
			<div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
				<div className="mx-auto max-w-2xl text-center">
					<p className="text-sm font-semibold text-blue-700">How it runs</p>
					<h2 id="home-runtime-heading" className="mt-2 text-3xl font-bold tracking-tight text-neutral-950 sm:text-4xl">
						Your account, your server, your copy of the code.
					</h2>
					<p className="mt-4 text-base leading-7 text-neutral-600">
						{appName} has nothing to subscribe to. You deploy it, you update it when you choose, and your mail never
						leaves the storage you picked.
					</p>
				</div>
				<ul className="mt-12 grid grid-cols-1 gap-5 lg:grid-cols-3">
					{runtimeCards.map((card) => {
						const Icon = card.icon;
						return (
							<li
								key={card.id}
								id={`runtime-${card.id}`}
								className="flex flex-col rounded-2xl border border-neutral-200 bg-[#f6f8fc] p-6"
							>
								<span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-blue-700 shadow-sm">
									<Icon className="h-5 w-5" />
								</span>
								<h3 className="mt-4 text-lg font-semibold tracking-tight text-neutral-950">{card.title}</h3>
								{card.lines.map((line) => (
									<p key={line} className="mt-2 text-sm leading-6 text-neutral-600">
										{line}
									</p>
								))}
								<a
									href={card.link.href}
									target="_blank"
									rel="noopener noreferrer"
									className="mt-auto inline-flex items-center gap-1 pt-5 text-sm font-semibold text-blue-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
								>
									{card.link.label}
									<ArrowUpRight className="h-4 w-4" aria-hidden="true" />
								</a>
							</li>
						);
					})}
				</ul>
			</div>
		</section>
	);
}

export function HomeFooter({ appName }: HomeSectionProps) {
	return (
		<footer className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-10 text-sm text-neutral-500 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
			<p>
				{appName} is based on{" "}
				<a href={UPSTREAM_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
					Mailflare
				</a>{" "}
				by hieunc229, under the same AGPL-3.0 license.
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
