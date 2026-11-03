import { ArrowUpRight } from "lucide-react";
import { DEPLOY_URL, DOCS_URL, UPSTREAM_URL } from "./utils";
import { HomeDeployPrompt } from "./home-deploy-prompt";
import { HomeHeroActions } from "./home-hero-actions";
import { HomeKiteArt } from "./home-kite-art";
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
import { MONO, PAGE_X, HomeSection, HomeTable, ghostButton, primaryButton, textLink } from "./home-ui";
import type { HomeSectionProps, HomeTextPart } from "./types";

function FaqAnswer({ parts }: { parts: HomeTextPart[] }) {
	return (
		<p className="max-w-[34rem] pb-6 text-pretty text-[15px] leading-7 text-(--home-mute)">
			{parts.map((part) => {
				if (part.href) {
					return (
						<a key={part.text} href={part.href} target="_blank" rel="noopener noreferrer" className={textLink}>
							{part.text}
						</a>
					);
				}
				if (part.code) {
					return (
						<code
							key={part.text}
							className={`${MONO} rounded-sm border border-(--home-line) px-1.5 py-0.5 text-(--home-ink)`}
						>
							{part.text}
						</code>
					);
				}
				return <span key={part.text}>{part.text}</span>;
			})}
		</p>
	);
}

/** The approved facts as one hairline row of small mono lines. No counts of stars or users. */
export function HomeProof() {
	return (
		<section aria-label="Proof" className="border-t border-(--home-line)">
			<ul className={`${PAGE_X} grid grid-cols-2 lg:grid-cols-6`}>
				{proofChips.map((chip) => (
					<li
						key={chip}
						className={`${MONO} border-l border-(--home-line) px-4 py-6 leading-5 text-(--home-mute) first:border-l-0 max-lg:odd:border-l-0 max-lg:nth-[n+3]:border-t lg:first:pl-0`}
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
		<HomeSection
			id="deploy"
			headingId="home-deploy-heading"
			title="Deploy in five steps"
			intro={`About 10 minutes the first time, for a domain whose DNS is already on Cloudflare. ${appName} sets up Email Routing for you. You still create the token, set the address and finish setup.`}
		>
			<ol className="border-b border-(--home-line)">
				{deploySteps.map((step, index) => (
					<li
						key={step.title}
						className="grid grid-cols-[2.5rem_1fr] gap-x-4 gap-y-2 border-t border-(--home-line) py-7 first:border-t-0 first:pt-0 md:grid-cols-12 md:gap-x-8"
					>
						<span aria-hidden="true" className={`${MONO} pt-1.5 text-(--home-dim) md:col-span-1`}>
							{String(index + 1).padStart(2, "0")}
						</span>
						<h3 className="text-xl font-medium tracking-[-0.02em] md:col-span-4">{step.title}</h3>
						<p className="col-start-2 text-pretty text-[15px] leading-7 text-(--home-mute) md:col-span-7 md:col-start-auto">
							{step.text}
						</p>
					</li>
				))}
			</ol>
			<div className="mt-10 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
				<a href={DEPLOY_URL} target="_blank" rel="noopener noreferrer" className={primaryButton}>
					Deploy to Cloudflare
					<ArrowUpRight className="h-4 w-4" aria-hidden="true" />
				</a>
				<a href={DEPLOYMENT_GUIDE_URL} target="_blank" rel="noopener noreferrer" className={ghostButton}>
					Read the deployment guide
					<ArrowUpRight className="h-4 w-4" aria-hidden="true" />
				</a>
			</div>
			<div className="mt-16 grid gap-12 border-t border-(--home-line) pt-12 lg:grid-cols-2 lg:gap-0">
				<div className="min-w-0 lg:pr-12">
					<h3 className="text-xl font-medium tracking-[-0.02em]">Prefer a box?</h3>
					<p className="mt-3 text-pretty text-[15px] leading-7 text-(--home-mute)">
						Run one container with SQLite and local files. A built-in SMTP listener, or a small relay Worker, receives
						mail. Any SMTP relay, Cloudflare, Resend or Amazon SES sends it.
					</p>
					<pre
						className={`${MONO} mt-5 overflow-x-auto rounded-lg border border-(--home-line) bg-black px-4 py-3 text-sm text-(--home-ink)`}
					>
						docker compose up -d --build
					</pre>
					<a
						href={SELF_HOST_URL}
						target="_blank"
						rel="noopener noreferrer"
						className={`mt-5 inline-flex items-center gap-1 text-[15px] ${textLink}`}
					>
						Self-hosting guide
						<ArrowUpRight className="h-4 w-4" aria-hidden="true" />
					</a>
				</div>
				<div className="min-w-0 lg:border-l lg:border-(--home-line) lg:pl-12">
					<h3 className="text-xl font-medium tracking-[-0.02em]">Or paste the deploy prompt into a coding agent</h3>
					<details suppressHydrationWarning className="group mt-3">
						<summary className={`cursor-pointer list-none text-[15px] ${textLink} [&::-webkit-details-marker]:hidden`}>
							Show the deploy prompt
						</summary>
						<HomeDeployPrompt />
					</details>
					<p className="mt-4 text-pretty text-[15px] leading-7 text-(--home-mute)">
						The prompt is the one in the README. It tells the agent to ask for your tokens, and never to print them.
					</p>
				</div>
			</div>
		</HomeSection>
	);
}

/** Provider prices from the README. No yearly SaaS total: the repo does not state one. */
export function HomeCost({ appName }: HomeSectionProps) {
	return (
		<HomeSection
			id="cost"
			headingId="home-cost-heading"
			title="Free to receive, free tiers to send"
			intro={`Receiving through Cloudflare Email Routing is free. You pay your own Cloudflare and sending-provider usage, and ${appName} itself costs nothing.`}
		>
			<HomeTable
				label="Sending prices by provider"
				from="md"
				cornerLabel="Send with"
				columns={[{ label: "Free tier" }, { label: "After that", ink: true }]}
				rows={costRows.map((row) => ({ key: row.provider, head: row.provider, cells: [row.free, row.after] }))}
				rowHeadClassName="text-lg font-medium tracking-[-0.01em]"
			/>
			<p className="mt-8 max-w-[34rem] text-pretty text-[15px] leading-7 text-(--home-mute)">
				Receiving: Cloudflare Email Routing is free. Resend receiving is included in every plan. Amazon SES receiving is
				$0.10 per 1,000 messages, plus small S3 and SNS charges. New Amazon SES accounts start in a sandbox that only
				delivers to verified addresses.
			</p>
			<p className="mt-4 max-w-[34rem] text-pretty text-sm leading-6 text-(--home-dim)">
				Figures from Kite&apos;s README as of 2 Nov 2026. Prices change, so check{" "}
				{costLinks.map((link, index) => (
					<span key={link.href}>
						{index > 0 && (index === costLinks.length - 1 ? " and " : ", ")}
						<a href={link.href} target="_blank" rel="noopener noreferrer" className={textLink}>
							{link.label}
						</a>
					</span>
				))}{" "}
				before you rely on them.
			</p>
		</HomeSection>
	);
}

/** Kite, Mailflare, Email Routing and a hosted inbox. The honest cells stay, including where Kite is behind. */
export function HomeCompare({ appName }: HomeSectionProps) {
	return (
		<HomeSection
			id="compare"
			headingId="home-compare-heading"
			title="When Kite fits, and when it doesn't"
			stacked
			intro={
				<>
					Choose Email Routing alone if forwarding is enough, a hosted inbox if you want polish and someone on call, and{" "}
					<a href={UPSTREAM_URL} target="_blank" rel="noopener noreferrer" className={textLink}>
						Mailflare
					</a>{" "}
					if you want the upstream project.
				</>
			}
		>
			<HomeTable
				label="Comparison of Kite, Mailflare, Email Routing and hosted inboxes"
				from="lg"
				columns={compareColumns.map((column, index) => ({
					label: index === 0 ? appName : column,
					ink: index === 0,
				}))}
				rows={compareRows.map((row) => ({ key: row.label, head: row.label, cells: row.cells }))}
				rowHeadClassName="text-sm font-normal text-(--home-dim)"
			/>
			<HomeUpstream />
		</HomeSection>
	);
}

/** README performance rows only. Before is the earlier result; Now is this version. */
function HomeUpstream() {
	return (
		<div className="mt-20 grid gap-x-10 gap-y-8 border-t border-(--home-line) pt-12 lg:grid-cols-12">
			<div className="lg:col-span-4">
				<h3 id="home-upstream-heading" className="text-2xl font-medium tracking-[-0.02em]">
					Before and now
				</h3>
				<p className="mt-3 max-w-sm text-pretty text-[15px] leading-7 text-(--home-mute)">
					Measured on a production build in a plain Chrome profile.{" "}
					<a href={PERFORMANCE_URL} target="_blank" rel="noopener noreferrer" className={textLink}>
						Performance in the README
					</a>
					.
				</p>
			</div>
			<div className="min-w-0 lg:col-span-8">
				<HomeTable
					label="Before and now"
					from="md"
					columns={[{ label: "Before" }, { label: "Now", ink: true }]}
					rows={upstreamRows.map((row) => ({ key: row.label, head: row.label, cells: [row.before, row.now] }))}
					rowHeadClassName="w-1/3 text-base font-medium"
				/>
			</div>
		</div>
	);
}

/** The stand-in for testimonials: links to the public record, and no quotes. */
export function HomeOpen() {
	return (
		<section aria-labelledby="home-open-heading" className="border-t border-(--home-line)">
			<div className={`${PAGE_X} flex flex-col gap-6 py-12 lg:flex-row lg:items-center lg:justify-between`}>
				<div>
					<h2 id="home-open-heading" className="text-xl font-medium tracking-[-0.02em]">
						Built in the open
					</h2>
					<p className="mt-1 text-[15px] text-(--home-mute)">
						Changelog, releases, roadmap and discussions. No quotes yet.
					</p>
				</div>
				<nav aria-label="Project record" className={`${MONO} flex flex-wrap gap-x-7 gap-y-3 text-sm`}>
					{openLinks.map((link) => (
						<a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer" className={textLink}>
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
		<HomeSection id="limits" headingId="home-limits-heading" title="Early beta: what's missing today">
			<ul className="border-b border-(--home-line)">
				{limitations.map((item) => (
					<li
						key={item}
						className="border-t border-(--home-line) py-4 text-[17px] leading-7 first:border-t-0 first:pt-0"
					>
						{item}
					</li>
				))}
			</ul>
			<p className="mt-6 text-[15px]">
				<a href={LIMITATIONS_URL} target="_blank" rel="noopener noreferrer" className={textLink}>
					See all known limitations
				</a>
			</p>
		</HomeSection>
	);
}

export function HomeFaq() {
	return (
		<HomeSection id="faq" headingId="home-faq-heading" title="FAQ">
			<div className="border-b border-(--home-line)">
				{faqs.map((faq) => (
					<details
						key={faq.question}
						suppressHydrationWarning
						className="group border-t border-(--home-line) first:border-t-0"
					>
						<summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-6 text-lg font-medium tracking-[-0.01em] transition-colors hover:text-white [&::-webkit-details-marker]:hidden">
							{faq.question}
							<span aria-hidden="true" className={`${MONO} text-base text-(--home-dim) group-open:hidden`}>
								+
							</span>
							<span aria-hidden="true" className={`${MONO} hidden text-base text-(--home-dim) group-open:inline`}>
								–
							</span>
						</summary>
						<FaqAnswer parts={faq.parts} />
					</details>
				))}
			</div>
		</HomeSection>
	);
}

export function HomeClosing({ appName }: HomeSectionProps) {
	return (
		<section aria-labelledby="home-closing-heading" className="relative overflow-hidden border-t border-(--home-line)">
			<HomeKiteArt className="pointer-events-none absolute right-0 top-[4%] hidden h-[92%] w-auto lg:block" />
			<div className={`${PAGE_X} relative py-24 lg:py-40`}>
				<h2
					id="home-closing-heading"
					className="text-balance text-[clamp(2.6rem,8.5vw,7rem)] font-medium leading-[1] tracking-[-0.04em]"
				>
					Run your own inbox.
				</h2>
				<p className="mt-6 max-w-lg text-pretty text-lg leading-8 text-(--home-mute)">
					Open source, every feature included, deployed into your own Cloudflare account.
				</p>
				<ul className={`${MONO} mt-6 flex flex-wrap gap-x-6 gap-y-2 text-(--home-dim)`}>
					{["AGPL-3.0", "Early beta", `${appName} is young`].map((item) => (
						<li key={item}>{item}</li>
					))}
				</ul>
				<div className="mt-10">
					<HomeHeroActions>
						<a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className={ghostButton}>
							Read the docs
						</a>
					</HomeHeroActions>
				</div>
			</div>
		</section>
	);
}
