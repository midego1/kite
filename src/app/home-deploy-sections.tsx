import { ArrowUpRight } from "lucide-react";
import { DEPLOY_URL } from "./utils";
import { HomeDeployPrompt } from "./home-deploy-prompt";
import { DEPLOYMENT_GUIDE_URL, SELF_HOST_URL, costLinks, costRows, deploySteps } from "./home-content";
import { Balloon } from "./home-sections";
import { HomeTable } from "./home-table";
import { HomeSection, MONO, ghostButton, primaryButton, textLink } from "./home-ui";
import type { HomeSectionProps } from "./types";

/** Five deploy steps as an assembly sequence on one axis, then Docker, then the agent prompt copied from the README. */
export function HomeDeploy({ appName }: HomeSectionProps) {
	return (
		<HomeSection
			id="deploy"
			headingId="home-deploy-heading"
			title="Deploy in five steps"
			intro={`About 10 minutes the first time, for a domain whose DNS is already on Cloudflare. ${appName} sets up Email Routing for you. You still create the token, set the address and finish setup.`}
		>
			<ol>
				{deploySteps.map((step, index) => (
					<li key={step.title} className="relative grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-4 pb-10">
						{index < deploySteps.length - 1 && (
							<span
								aria-hidden="true"
								className="absolute bottom-1 left-[13.5px] top-9 border-l border-dashed border-(--home-line-strong)"
							/>
						)}
						<Balloon n={index + 1} />
						<div>
							<h3 className="pt-0.5 text-xl font-medium leading-tight tracking-[-0.02em]">{step.title}</h3>
							<p className="mt-2 max-w-[38rem] text-pretty text-[15px] leading-7 text-(--home-mute)">{step.text}</p>
						</div>
					</li>
				))}
			</ol>
			<div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
				<a href={DEPLOY_URL} target="_blank" rel="noopener noreferrer" className={primaryButton}>
					Deploy to Cloudflare
					<ArrowUpRight className="h-4 w-4" aria-hidden="true" />
				</a>
				<a href={DEPLOYMENT_GUIDE_URL} target="_blank" rel="noopener noreferrer" className={ghostButton}>
					Read the deployment guide
					<ArrowUpRight className="h-4 w-4" aria-hidden="true" />
				</a>
			</div>
			<div className="mt-16 grid gap-12 border-t border-(--home-line) pt-12 xl:grid-cols-2 xl:gap-0">
				<div className="min-w-0 xl:pr-10">
					<h3 className="text-xl font-medium tracking-[-0.02em]">Prefer a box?</h3>
					<p className="mt-3 text-pretty text-[15px] leading-7 text-(--home-mute)">
						Run one container with SQLite and local files. A built-in SMTP listener, or a small relay Worker, receives
						mail. Any SMTP relay, Cloudflare, Resend or Amazon SES sends it.
					</p>
					<pre
						className={`${MONO} mt-5 overflow-x-auto rounded-lg border border-(--home-line) bg-(--home-code) px-4 py-3 text-sm text-(--home-ink)`}
					>
						docker compose up -d --build
					</pre>
					<a
						href={SELF_HOST_URL}
						target="_blank"
						rel="noopener noreferrer"
						className={`mt-4 inline-flex items-center gap-1 py-1 text-[15px] ${textLink}`}
					>
						Self-hosting guide
						<ArrowUpRight className="h-4 w-4" aria-hidden="true" />
					</a>
				</div>
				<div className="min-w-0 xl:border-l xl:border-(--home-line) xl:pl-10">
					<h3 className="text-xl font-medium tracking-[-0.02em]">Or paste the deploy prompt into a coding agent</h3>
					<details suppressHydrationWarning className="group mt-3">
						<summary
							className={`inline-block cursor-pointer list-none py-1 text-[15px] ${textLink} [&::-webkit-details-marker]:hidden`}
						>
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

/** Provider prices from the README as a schedule. No yearly SaaS total: the repo does not state one. */
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
