import { ArrowUpRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DOCS_URL, UPSTREAM_URL } from "./utils";
import { HomeDeployPrompt } from "./home-deploy-prompt";
import { HomeHeroActions } from "./home-hero-actions";
import {
	DEPLOYMENT_GUIDE_URL,
	LIMITATIONS_URL,
	SELF_HOST_URL,
	compareColumns,
	compareRows,
	costLinks,
	costRows,
	deploySteps,
	faqs,
	limitations,
	PERFORMANCE_URL,
	openLinks,
	proofChips,
	upstreamRows,
} from "./home-content";
import type { HomeSectionProps, HomeTextPart } from "./types";

const textLinkClass =
	"font-semibold text-blue-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600";

function FaqAnswer({ parts }: { parts: HomeTextPart[] }) {
	return (
		<p className="mt-3 text-sm leading-6 text-neutral-600">
			{parts.map((part) => {
				if (part.href) {
					return (
						<a key={part.text} href={part.href} target="_blank" rel="noopener noreferrer" className={textLinkClass}>
							{part.text}
						</a>
					);
				}
				if (part.code) {
					return (
						<code key={part.text} className="rounded bg-white px-1 py-0.5 text-[0.85em] text-neutral-800">
							{part.text}
						</code>
					);
				}
				return <span key={part.text}>{part.text}</span>;
			})}
		</p>
	);
}

/** The approved facts, as a single wrapping row. No counts of stars or users. */
export function HomeProof() {
	return (
		<section aria-label="Proof" className="mx-auto max-w-5xl px-4 pb-4 sm:px-6 lg:px-8">
			<ul className="flex flex-wrap justify-center gap-2">
				{proofChips.map((chip) => (
					<li
						key={chip}
						className="rounded-full border border-neutral-200 bg-white px-3 py-1 text-sm font-medium text-neutral-800"
					>
						{chip}
					</li>
				))}
			</ul>
		</section>
	);
}

/** Five deploy steps, then Docker, then the agent prompt copied from the README. */
export function HomeDeploy({ appName }: HomeSectionProps) {
	return (
		<section id="deploy" aria-labelledby="home-deploy-heading" className="border-y border-neutral-200 bg-white py-16">
			<div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
				<div className="mx-auto max-w-2xl text-center">
					<p className="text-sm font-semibold text-blue-700">Deploy</p>
					<h2 id="home-deploy-heading" className="mt-2 text-3xl font-bold tracking-tight text-neutral-950 sm:text-4xl">
						Deploy in five steps
					</h2>
					<p className="mt-4 text-base leading-7 text-neutral-600">
						About 10 minutes the first time, for a domain whose DNS is already on Cloudflare. {appName} sets up Email
						Routing for you. You still create the token, set the address and finish setup.
					</p>
				</div>
				<ol className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-5">
					{deploySteps.map((step, index) => (
						<li key={step.title} className="flex flex-col rounded-2xl border border-neutral-200 bg-[#f6f8fc] p-5">
							<span className="text-sm font-semibold tabular-nums text-neutral-400">
								{String(index + 1).padStart(2, "0")}
							</span>
							<h3 className="mt-3 text-base font-semibold tracking-tight text-neutral-950">{step.title}</h3>
							<p className="mt-2 text-sm leading-6 text-neutral-600">{step.text}</p>
						</li>
					))}
				</ol>
				<div className="mt-8 flex justify-center">
					<Button size="lg" variant="outline" asChild className="rounded-full bg-[#f6f8fc] px-6">
						<a href={DEPLOYMENT_GUIDE_URL} target="_blank" rel="noopener noreferrer">
							Read the deployment guide
							<ArrowUpRight className="h-4 w-4" />
						</a>
					</Button>
				</div>
				<div className="mx-auto mt-12 grid max-w-5xl grid-cols-1 gap-5 lg:grid-cols-2">
					<div className="min-w-0 rounded-2xl border border-neutral-200 p-6">
						<h3 className="text-lg font-semibold tracking-tight text-neutral-950">Prefer a box?</h3>
						<p className="mt-2 text-sm leading-6 text-neutral-600">
							Run one container with SQLite and local files. A built-in SMTP listener, or a small relay Worker, receives
							mail. Any SMTP relay, Cloudflare, Resend or Amazon SES sends it.
						</p>
						<pre className="mt-4 overflow-x-auto rounded-xl bg-[#f6f8fc] px-4 py-3 font-mono text-sm text-neutral-800">
							docker compose up -d --build
						</pre>
						<a
							href={SELF_HOST_URL}
							target="_blank"
							rel="noopener noreferrer"
							className={`mt-4 inline-flex ${textLinkClass}`}
						>
							Self-hosting guide
							<ArrowUpRight className="h-4 w-4" aria-hidden="true" />
						</a>
					</div>
					<div className="min-w-0 rounded-2xl border border-neutral-200 p-6">
						<h3 className="text-lg font-semibold tracking-tight text-neutral-950">
							Or paste the deploy prompt into a coding agent
						</h3>
						<details suppressHydrationWarning className="group mt-2">
							<summary className="cursor-pointer list-none text-sm font-semibold text-blue-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 [&::-webkit-details-marker]:hidden">
								Show the deploy prompt
							</summary>
							<HomeDeployPrompt />
						</details>
						<p className="mt-3 text-sm leading-6 text-neutral-600">
							The prompt is the one in the README. It tells the agent to ask for your tokens, and never to print them.
						</p>
					</div>
				</div>
			</div>
		</section>
	);
}

/** Provider prices from the README. No yearly SaaS total: the repo does not state one. */
export function HomeCost({ appName }: HomeSectionProps) {
	return (
		<section id="cost" aria-labelledby="home-cost-heading" className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
			<div className="mx-auto max-w-2xl text-center">
				<p className="text-sm font-semibold text-blue-700">Cost</p>
				<h2 id="home-cost-heading" className="mt-2 text-3xl font-bold tracking-tight text-neutral-950 sm:text-4xl">
					Free to receive, free tiers to send
				</h2>
				<p className="mt-4 text-base leading-7 text-neutral-600">
					Receiving through Cloudflare Email Routing is free. You pay your own Cloudflare and sending-provider usage,
					and {appName} itself costs nothing.
				</p>
			</div>
			<div
				className="mx-auto mt-10 max-w-4xl min-w-0 overflow-x-auto rounded-2xl border border-neutral-200 bg-white"
				tabIndex={0}
			>
				<table className="w-full min-w-[640px] border-collapse text-left text-sm">
					<thead>
						<tr className="border-b border-neutral-200 bg-[#f6f8fc]">
							<th scope="col" className="px-5 py-3 font-semibold text-neutral-950">
								Send with
							</th>
							<th scope="col" className="px-5 py-3 font-semibold text-neutral-950">
								Free tier
							</th>
							<th scope="col" className="px-5 py-3 font-semibold text-neutral-950">
								After that
							</th>
						</tr>
					</thead>
					<tbody>
						{costRows.map((row) => (
							<tr key={row.provider} className="border-b border-neutral-100 align-top last:border-b-0">
								<th scope="row" className="px-5 py-4 font-medium text-neutral-950">
									{row.provider}
								</th>
								<td className="px-5 py-4 leading-6 text-neutral-700">{row.free}</td>
								<td className="px-5 py-4 leading-6 text-neutral-700">{row.after}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<p className="mx-auto mt-4 max-w-4xl text-sm leading-6 text-neutral-600">
				Receiving: Cloudflare Email Routing is free. Resend receiving is included in every plan. Amazon SES receiving is
				$0.10 per 1,000 messages, plus small S3 and SNS charges. New Amazon SES accounts start in a sandbox that only
				delivers to verified addresses.
			</p>
			<p className="mx-auto mt-2 max-w-4xl text-xs leading-5 text-neutral-500">
				Figures from Kite&apos;s README as of 2 Nov 2026. Prices change, so check{" "}
				{costLinks.map((link, index) => (
					<span key={link.href}>
						{index > 0 && (index === costLinks.length - 1 ? " and " : ", ")}
						<a href={link.href} target="_blank" rel="noopener noreferrer" className={textLinkClass}>
							{link.label}
						</a>
					</span>
				))}{" "}
				before you rely on them.
			</p>
		</section>
	);
}

/** Kite, Mailflare, Email Routing and a hosted inbox. The honest cells stay, including where Kite is behind. */
export function HomeCompare({ appName }: HomeSectionProps) {
	return (
		<section
			id="compare"
			aria-labelledby="home-compare-heading"
			className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8"
		>
			<div className="mx-auto max-w-2xl text-center">
				<p className="text-sm font-semibold text-blue-700">Compared</p>
				<h2 id="home-compare-heading" className="mt-2 text-3xl font-bold tracking-tight text-neutral-950 sm:text-4xl">
					When Kite fits, and when it doesn&apos;t
				</h2>
				<p className="mt-4 text-base leading-7 text-neutral-600">
					Choose Email Routing alone if forwarding is enough, a hosted inbox if you want polish and someone on call, and{" "}
					<a href={UPSTREAM_URL} target="_blank" rel="noopener noreferrer" className={textLinkClass}>
						Mailflare
					</a>{" "}
					if you want the upstream project.
				</p>
			</div>
			<div
				className="mt-10 min-w-0 overflow-x-auto rounded-2xl border border-neutral-200 bg-white"
				tabIndex={0}
				role="region"
				aria-label="Comparison of Kite, Mailflare, Email Routing and hosted inboxes"
			>
				<table className="w-full min-w-[880px] border-collapse text-left text-sm">
					<thead>
						<tr className="border-b border-neutral-200 bg-[#f6f8fc]">
							<td className="w-40 px-4 py-4" />
							{compareColumns.map((column, index) => (
								<th
									key={column}
									scope="col"
									className={`px-4 py-4 font-semibold ${index === 0 ? "text-blue-700" : "text-neutral-700"}`}
								>
									{index === 0 ? appName : column}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{compareRows.map((row) => (
							<tr key={row.label} className="border-b border-neutral-100 align-top last:border-b-0">
								<th scope="row" className="px-4 py-4 font-medium text-neutral-950">
									{row.label}
								</th>
								{row.cells.map((cell, index) => (
									<td
										key={compareColumns[index]}
										className={`px-4 py-4 leading-6 ${index === 0 ? "bg-[#eef3fb] text-neutral-900" : "text-neutral-600"}`}
									>
										{cell}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<HomeUpstream />
		</section>
	);
}

/** README performance rows only. Before is the earlier result; Now is this version. */
function HomeUpstream() {
	return (
		<div className="mx-auto mt-12 max-w-3xl">
			<h3 id="home-upstream-heading" className="text-center text-lg font-semibold tracking-tight text-neutral-950">
				Vs upstream
			</h3>
			<p className="mt-2 text-center text-sm leading-6 text-neutral-600">
				Measured on a production build in a plain Chrome profile.{" "}
				<a href={PERFORMANCE_URL} target="_blank" rel="noopener noreferrer" className={textLinkClass}>
					Performance in the README
				</a>
				.
			</p>
			<div className="mt-5 min-w-0 overflow-x-auto rounded-2xl border border-neutral-200 bg-white" tabIndex={0}>
				<table className="w-full min-w-[640px] border-collapse text-left text-sm">
					<thead>
						<tr className="border-b border-neutral-200 bg-[#f6f8fc]">
							<td className="px-4 py-3" />
							<th scope="col" className="px-4 py-3 font-semibold text-neutral-700">
								Before
							</th>
							<th scope="col" className="px-4 py-3 font-semibold text-neutral-950">
								Now
							</th>
						</tr>
					</thead>
					<tbody>
						{upstreamRows.map((row) => (
							<tr key={row.label} className="border-b border-neutral-100 align-top last:border-b-0">
								<th scope="row" className="px-4 py-4 font-medium text-neutral-950">
									{row.label}
								</th>
								<td className="px-4 py-4 leading-6 text-neutral-600">{row.before}</td>
								<td className="px-4 py-4 leading-6 text-neutral-900">{row.now}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

/** The stand-in for testimonials: links to the public record, and no quotes. */
export function HomeOpen() {
	return (
		<section aria-labelledby="home-open-heading" className="border-y border-neutral-200 bg-white py-12">
			<div className="mx-auto flex max-w-7xl flex-col items-start gap-4 px-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
				<div>
					<h2 id="home-open-heading" className="text-lg font-semibold tracking-tight text-neutral-950">
						Built in the open
					</h2>
					<p className="mt-1 text-sm text-neutral-600">Changelog, releases, roadmap and discussions. No quotes yet.</p>
				</div>
				<nav aria-label="Project record" className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
					{openLinks.map((link) => (
						<a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer" className={textLinkClass}>
							{link.label}
						</a>
					))}
				</nav>
			</div>
		</section>
	);
}

export function HomeLimits() {
	return (
		<section id="limits" aria-labelledby="home-limits-heading" className="mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:px-8">
			<h2
				id="home-limits-heading"
				className="text-center text-3xl font-bold tracking-tight text-neutral-950 sm:text-4xl"
			>
				Early beta: what&apos;s missing today
			</h2>
			<ul className="mt-8 space-y-3">
				{limitations.map((item) => (
					<li key={item} className="flex gap-3 text-sm leading-6 text-neutral-700">
						<span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-400" />
						<span>{item}</span>
					</li>
				))}
			</ul>
			<p className="mt-6 text-center text-sm">
				<a href={LIMITATIONS_URL} target="_blank" rel="noopener noreferrer" className={textLinkClass}>
					See all known limitations
				</a>
			</p>
		</section>
	);
}

export function HomeFaq() {
	return (
		<section id="faq" aria-labelledby="home-faq-heading" className="border-y border-neutral-200 bg-white py-16">
			<div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
				<h2
					id="home-faq-heading"
					className="text-center text-3xl font-bold tracking-tight text-neutral-950 sm:text-4xl"
				>
					FAQ
				</h2>
				<div className="mt-10 divide-y divide-neutral-200 rounded-2xl border border-neutral-200">
					{faqs.map((faq) => (
						<details key={faq.question} suppressHydrationWarning className="group px-5 py-4">
							<summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-base font-semibold text-neutral-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 [&::-webkit-details-marker]:hidden">
								{faq.question}
								<span aria-hidden="true" className="text-neutral-400 group-open:hidden">
									+
								</span>
								<span aria-hidden="true" className="hidden text-neutral-400 group-open:inline">
									–
								</span>
							</summary>
							<FaqAnswer parts={faq.parts} />
						</details>
					))}
				</div>
			</div>
		</section>
	);
}

export function HomeClosing({ appName }: HomeSectionProps) {
	return (
		<section
			aria-labelledby="home-closing-heading"
			className="mx-auto max-w-4xl px-4 py-20 text-center sm:px-6 lg:px-8"
		>
			<h2 id="home-closing-heading" className="text-3xl font-bold tracking-tight text-neutral-950 sm:text-4xl">
				Run your own inbox.
			</h2>
			<p className="mt-4 text-base leading-7 text-neutral-600">
				Open source, every feature included, deployed into your own Cloudflare account.
			</p>
			<ul className="mx-auto mt-5 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-neutral-600">
				{["AGPL-3.0", "Early beta", `${appName} is young`].map((item) => (
					<li key={item} className="flex items-center gap-2">
						<Check className="h-3.5 w-3.5 text-blue-500" aria-hidden="true" />
						{item}
					</li>
				))}
			</ul>
			<HomeHeroActions>
				<Button size="lg" variant="outline" asChild className="rounded-full border-neutral-200 bg-white px-6">
					<a href={DOCS_URL} target="_blank" rel="noopener noreferrer">
						Read the docs
						<ArrowUpRight className="h-4 w-4" />
					</a>
				</Button>
			</HomeHeroActions>
		</section>
	);
}
