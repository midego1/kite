import type { ReactNode } from "react";
import { FileText } from "lucide-react";
import { HomeCopyPrompt } from "./home-copy-prompt";
import { Bullets, EmailTable, ExternalLink, Heading, LINK, Mono, Para, Parts, Quiet } from "./home-email-parts";
import {
	BETA_LINE,
	CLOSING_LINE,
	COST_LEAD,
	COST_RECEIVING,
	DEPLOYMENT_GUIDE_URL,
	DEPLOY_LEAD,
	DEPLOY_PROMPT,
	DOCKER_COMMAND,
	DOCKER_TEXT,
	FEATURES_LEAD,
	LIMITATIONS_URL,
	PERFORMANCE_URL,
	PROMPT_NOTE,
	PROMPT_WARNING,
	SELF_HOST_URL,
	SETUP_NOTE,
	compareColumns,
	compareRows,
	costLinks,
	costRows,
	deploySteps,
	faqs,
	limitations,
	openLinks,
	proofChips,
	upstreamRows,
	welcomeIntro,
	HEADLINE,
} from "./home-content";
import { HomeKiteArt } from "./home-kite-art";
import { MONO } from "./home-ui";
import { UPSTREAM_URL, featureThemes } from "./utils";
import type { HomeEmailMeta, HomeFolderId, HomePerson, HomeSample } from "./home-mailbox-types";
import type { HomeTextPart } from "./types";

/*
 * Every section of the old page is an email from the product, in the folder that names it. The words are the
 * ones in home-content.ts and utils.ts, checked against the README; nothing is added here but the mail
 * framing (sender, folders). `text` is what the search box looks through.
 */

type Email = { meta: HomeEmailMeta; body: ReactNode };

const partsText = (parts: HomeTextPart[]) => parts.map((part) => part.text).join("");

function email(
	id: string,
	folder: HomeFolderId,
	subject: string,
	preview: string,
	text: string[],
	body: ReactNode,
	sample?: HomeSample,
): Email {
	const names = sample ? [sample.sender.name, sample.sender.address, "Example"] : [];
	// The suggestion card's draft is part of what the open email shows, so the search box finds it too.
	const suggestion = sample?.suggestion ? [sample.suggestion.text] : [];
	return {
		meta: {
			id,
			folder,
			subject,
			preview,
			text: [subject, preview, ...names, ...suggestion, ...text].join(" "),
			sample,
		},
		body,
	};
}

function welcome(appName: string): Email {
	const intro = welcomeIntro(appName);
	const young = `AGPL-3.0 · Early beta · ${appName} is young`;
	return email(
		"welcome",
		"inbox",
		HEADLINE,
		intro,
		[SETUP_NOTE, BETA_LINE, ...proofChips, "Run your own inbox.", CLOSING_LINE, young],
		<div className="grid gap-x-8 gap-y-6 @2xl:grid-cols-[minmax(0,1fr)_auto]">
			<div className="space-y-4">
				<Para>{intro}</Para>
				<Quiet>{SETUP_NOTE}</Quiet>
				<Mono>{BETA_LINE}</Mono>
				<ul aria-label="Facts" className={`${MONO} space-y-2 border-y border-neutral-200 py-4 text-neutral-600`}>
					{proofChips.map((chip) => (
						<li key={chip}>{chip}</li>
					))}
				</ul>
				<Heading level={2}>Run your own inbox.</Heading>
				<Para>{CLOSING_LINE}</Para>
				<Mono>{young}</Mono>
			</div>
			<div aria-hidden="true" className="pointer-events-none flex justify-center @2xl:justify-end">
				<HomeKiteArt className="block h-[440px] w-auto max-w-full" />
			</div>
		</div>,
	);
}

function openEmail(): Email {
	return email(
		"open",
		"inbox",
		"Built in the open",
		"Changelog, releases, roadmap and discussions. No quotes yet.",
		openLinks.map((link) => link.label),
		<>
			<Para>Changelog, releases, roadmap and discussions. No quotes yet.</Para>
			<ul className="flex flex-wrap gap-x-6 gap-y-2 text-[15px]">
				{openLinks.map((link) => (
					<li key={link.href}>
						<ExternalLink href={link.href}>{link.label}</ExternalLink>
					</li>
				))}
			</ul>
		</>,
	);
}

function featureEmails(): Email[] {
	const intro = email(
		"features-intro",
		"inbox",
		"Six parts. All of them included.",
		FEATURES_LEAD,
		featureThemes.map((theme) => theme.title),
		<>
			<Para>{FEATURES_LEAD}</Para>
			<ol className="space-y-1.5 text-[15px] leading-7">
				{featureThemes.map((theme, index) => (
					<li key={theme.id} className="flex gap-3">
						<span className={`${MONO} w-5 pt-1 text-neutral-500`}>{index + 1}</span>
						<a href={`#feature-${theme.id}`} className={LINK}>
							{theme.title}
						</a>
					</li>
				))}
			</ol>
		</>,
	);
	const themes = featureThemes.map((theme) =>
		email(
			`feature-${theme.id}`,
			"inbox",
			theme.title,
			theme.summary,
			[theme.summary, ...theme.points],
			<>
				<Para>{theme.summary}</Para>
				<Bullets items={theme.points} />
			</>,
		),
	);
	return [intro, ...themes];
}

/* Example mails: everyday mail from invented people (.test and .example addresses), to show how an inbox looks in use. */

const person = (name: string, address: string, avatarClassName: string): HomePerson => ({
	name,
	address,
	initial: name.charAt(0),
	own: false,
	avatarClassName,
});
const sofia = person("Sofia Marchetti", "sofia@northwind.test", "bg-neutral-200 text-neutral-700");
const lena = person("Lena Fischer", "lena@northwind.test", "bg-blue-100 text-blue-800");
const ava = person("Ava Lindqvist", "ava@lindqvist.example", "bg-amber-100 text-amber-800");
const fabrikam = person("Fabrikam Billing", "billing@fabrikam.example", "bg-violet-100 text-violet-800");

function Attachments({ files }: { files: { name: string; size: string; color: string }[] }) {
	return (
		<div>
			<p className="text-sm text-neutral-500">Attachments ({files.length})</p>
			<ul className="mt-2 flex flex-wrap gap-2">
				{files.map((file) => (
					<li
						key={file.name}
						className="inline-flex max-w-full flex-wrap items-center gap-x-2 rounded-lg border border-neutral-200 bg-[#f6f8fc] px-3 py-2 text-sm text-neutral-800 [overflow-wrap:anywhere]"
					>
						<FileText className={`h-4 w-4 ${file.color}`} aria-hidden="true" />
						{file.name}
						<span className="text-neutral-500">{file.size}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

function sampleEmails(): Email[] {
	const launch = [
		"Good call, the tour is in. Attached are the updated plan and the rollout checklist; shout if anything is missing before Monday.",
		"Sofia",
	];
	const review = [
		"Notes from this morning's review are in the doc. Two things still open: the empty state copy on the first screen, and whether the domain step can be skipped for people who want to try the inbox first.",
		"I lean towards letting them skip it. Thoughts?",
		"Lena",
	];
	const question = [
		"Hi, I run a small newsletter and a friend suggested I write to you. Could we find ten minutes next week to talk about sharing a mailing?",
		"Thanks, Ava",
	];
	const invoice = [
		"Your Fabrikam Team plan renews on November 3. This month's invoice (US$17.99) is attached. Nothing to do if your card on file is current.",
		"The Fabrikam billing team",
	];
	const paragraphs = (lines: string[]) => lines.map((line) => <Para key={line}>{line}</Para>);
	return [
		email(
			"sample-launch-plan",
			"inbox",
			"Re: Launch plan for the new inbox",
			launch[0],
			[...launch, "launch-plan.pdf", "rollout-checklist.csv", "Reply drafted"],
			<>
				{paragraphs(launch)}
				<Attachments
					files={[
						{ name: "launch-plan.pdf", size: "47 KB", color: "text-red-600" },
						{ name: "rollout-checklist.csv", size: "2 KB", color: "text-green-600" },
					]}
				/>
			</>,
			{
				sender: sofia,
				suggestion: {
					title: "Reply drafted",
					text: "Thanks Sofia, both files are in. The checklist still needs the DNS step from Daniel. We will confirm Monday morning.",
					action: "Review draft",
				},
			},
		),
		email(
			"sample-design-review",
			"inbox",
			"Design review notes for the new onboarding",
			review[0],
			review,
			<>{paragraphs(review)}</>,
			{
				sender: lena,
			},
		),
		email(
			"sample-api-question",
			"inbox",
			"A question about a shared mailing",
			question[0],
			question,
			<>{paragraphs(question)}</>,
			{
				sender: ava,
				screening: true,
			},
		),
		email(
			"sample-invoice",
			"inbox",
			"Your October invoice is ready",
			invoice[0],
			[...invoice, "fabrikam-invoice-2026-10.pdf"],
			<>
				{paragraphs(invoice)}
				<Attachments files={[{ name: "fabrikam-invoice-2026-10.pdf", size: "31 KB", color: "text-red-600" }]} />
			</>,
			{ sender: fabrikam },
		),
	];
}

function deployEmail(appName: string): Email {
	const lead = DEPLOY_LEAD(appName);
	return email(
		"deploy",
		"deploy",
		"Deploy in five steps",
		lead,
		[
			...deploySteps.flatMap((step) => [step.title, step.text]),
			DOCKER_TEXT,
			DOCKER_COMMAND,
			PROMPT_NOTE,
			PROMPT_WARNING,
			DEPLOY_PROMPT,
			"Self-hosting guide",
			"Read the deployment guide",
		],
		<>
			<Para>{lead}</Para>
			<ol className="space-y-4">
				{deploySteps.map((step, index) => (
					<li key={step.title} className="flex gap-3">
						<span
							aria-hidden="true"
							className={`${MONO} flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-neutral-300 text-neutral-600`}
						>
							{index + 1}
						</span>
						<div>
							<h3 className="pt-0.5 text-base font-semibold text-neutral-900">{step.title}</h3>
							<p className="mt-1 max-w-[68ch] text-[15px] leading-7 text-neutral-700">{step.text}</p>
						</div>
					</li>
				))}
			</ol>
			<p className="text-[15px]">
				<ExternalLink href={DEPLOYMENT_GUIDE_URL}>Read the deployment guide</ExternalLink>
			</p>
			<Heading>Prefer a box?</Heading>
			<Para>{DOCKER_TEXT}</Para>
			<pre
				className={`${MONO} overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-100 px-4 py-3 text-sm text-neutral-900`}
			>
				{DOCKER_COMMAND}
			</pre>
			<p className="text-[15px]">
				<ExternalLink href={SELF_HOST_URL}>Self-hosting guide</ExternalLink>
			</p>
			<Heading>Or paste the deploy prompt into a coding agent</Heading>
			<Quiet>{PROMPT_WARNING}</Quiet>
			<HomeCopyPrompt text={DEPLOY_PROMPT} />
			<Quiet>{PROMPT_NOTE}</Quiet>
		</>,
	);
}

function costEmail(appName: string): Email {
	const lead = COST_LEAD(appName);
	const note = "Figures from Kite's README as of 2 Nov 2026. Prices change, so check";
	return email(
		"cost",
		"cost",
		"Free to receive with Cloudflare, free tiers to send",
		lead,
		[
			...costRows.flatMap((row) => [row.provider, row.free, row.after]),
			COST_RECEIVING,
			note,
			...costLinks.map((link) => link.label),
		],
		<>
			<Para>{lead}</Para>
			<EmailTable
				label="Sending prices by provider"
				from="narrow"
				cornerLabel="Send with"
				columns={[{ label: "Free tier" }, { label: "After that", ink: true }]}
				rows={costRows.map((row) => ({ key: row.provider, head: row.provider, cells: [row.free, row.after] }))}
			/>
			<Para>{COST_RECEIVING}</Para>
			<Quiet>
				{note}{" "}
				{costLinks.map((link, index) => (
					<span key={link.href}>
						{index > 0 && (index === costLinks.length - 1 ? " and " : ", ")}
						<ExternalLink href={link.href}>{link.label}</ExternalLink>
					</span>
				))}{" "}
				before you rely on them.
			</Quiet>
		</>,
	);
}

function compareEmails(appName: string): Email[] {
	const lead =
		"Choose Email Routing alone if forwarding is enough, a hosted inbox if you want polish and someone on call, and Mailflare if you want the upstream project.";
	const columns = compareColumns.map((column, index) => ({ label: index === 0 ? appName : column, ink: index === 0 }));
	const compare = email(
		"compare",
		"compare",
		`When ${appName} fits, and when it doesn't`,
		lead,
		compareRows.flatMap((row) => [row.label, ...row.cells]),
		<>
			<Para>
				Choose Email Routing alone if forwarding is enough, a hosted inbox if you want polish and someone on call, and{" "}
				<ExternalLink href={UPSTREAM_URL}>Mailflare</ExternalLink> if you want the upstream project.
			</Para>
			<EmailTable
				label={`Comparison of ${appName}, Mailflare, Email Routing and hosted inboxes`}
				from="wide"
				columns={columns}
				rows={compareRows.map((row) => ({ key: row.label, head: row.label, cells: row.cells }))}
			/>
		</>,
	);
	const before = email(
		"before-and-now",
		"compare",
		"Before and now",
		"Measured on a production build in a plain Chrome profile.",
		upstreamRows.flatMap((row) => [row.label, row.before, row.now]),
		<>
			<Para>
				Measured on a production build in a plain Chrome profile.{" "}
				<ExternalLink href={PERFORMANCE_URL}>Performance in the README</ExternalLink>.
			</Para>
			<EmailTable
				label="Before and now"
				from="narrow"
				columns={[{ label: "Before" }, { label: "Now", ink: true, big: true }]}
				rows={upstreamRows.map((row) => ({ key: row.label, head: row.label, cells: [row.before, row.now] }))}
			/>
		</>,
	);
	return [compare, before];
}

function limitsEmail(): Email {
	return email(
		"limits",
		"limits",
		"Early beta: what's missing today",
		limitations[0],
		limitations,
		<>
			<ol className="max-w-[68ch] list-decimal space-y-2 ps-6 text-[15px] leading-7 text-neutral-800 marker:text-neutral-500">
				{limitations.map((item) => (
					<li key={item}>{item}</li>
				))}
			</ol>
			<p className="text-[15px]">
				<ExternalLink href={LIMITATIONS_URL}>See all known limitations</ExternalLink>
			</p>
		</>,
	);
}

const FAQ_IDS = ["faq-mailflare", "faq-cost", "faq-cloudflare", "faq-clients", "faq-phone-home", "faq-ai", "faq-move"];

function faqEmails(): Email[] {
	return faqs.map((faq, index) => {
		const answer = partsText(faq.parts);
		return email(
			FAQ_IDS[index],
			"faq",
			faq.question,
			answer,
			[answer],
			<Para>
				<Parts parts={faq.parts} />
			</Para>,
		);
	});
}

/** The emails in list order, with their bodies. */
export function buildHomeEmails(appName: string): { metas: HomeEmailMeta[]; bodies: Record<string, ReactNode> } {
	const all = [
		welcome(appName),
		...featureEmails(),
		...sampleEmails(),
		openEmail(),
		deployEmail(appName),
		costEmail(appName),
		...compareEmails(appName),
		limitsEmail(),
		...faqEmails(),
	];
	return {
		metas: all.map((item) => item.meta),
		bodies: Object.fromEntries(all.map((item) => [item.meta.id, item.body])),
	};
}
