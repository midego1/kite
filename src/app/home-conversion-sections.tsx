import { DOCS_URL } from "./utils";
import { HomeHeroActions } from "./home-hero-actions";
import { LIMITATIONS_URL, faqs, limitations, openLinks, proofChips } from "./home-content";
import { HomeTowDetail } from "./home-tow-detail";
import { Cross, HomeSection, MONO, PAD, ghostButton, textLink } from "./home-ui";
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

/** The approved facts as one ruled strip of small mono cells. No counts of stars or users. */
export function HomeProof() {
	return (
		<section aria-label="Proof" className="relative border-t border-(--home-line)">
			<Cross className="left-0 -top-[6.5px]" />
			<Cross className="right-0 -top-[6.5px]" />
			<ul className="grid grid-cols-2 lg:grid-cols-6">
				{proofChips.map((chip) => (
					<li
						key={chip}
						className={`${MONO} border-l border-(--home-line) px-5 py-6 leading-5 text-(--home-mute) first:border-l-0 max-lg:odd:border-l-0 max-lg:nth-[n+3]:border-t sm:px-8 lg:px-6 lg:first:pl-12`}
					>
						{chip}
					</li>
				))}
			</ul>
		</section>
	);
}

/** The stand-in for testimonials: links to the public record, and no quotes. */
export function HomeOpen() {
	return (
		<section aria-labelledby="home-open-heading" className="relative border-t border-(--home-line)">
			<Cross className="left-0 -top-[6.5px]" />
			<Cross className="right-0 -top-[6.5px]" />
			<div className={`${PAD} flex flex-col gap-6 py-12 lg:flex-row lg:items-center lg:justify-between`}>
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
						<a
							key={link.href}
							href={link.href}
							target="_blank"
							rel="noopener noreferrer"
							className={`py-1 ${textLink}`}
						>
							{link.label}
						</a>
					))}
				</nav>
			</div>
		</section>
	);
}

/** The limits as general notes: a numbered list, as a drawing keeps them. */
export function HomeLimits() {
	return (
		<HomeSection id="limits" headingId="home-limits-heading" title="Early beta: what's missing today">
			<ol className="border-b border-(--home-line)">
				{limitations.map((item, index) => (
					<li
						key={item}
						className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-4 border-t border-(--home-line) py-4 text-[17px] leading-7 first:border-t-0 first:pt-0"
					>
						<span aria-hidden="true" className={`${MONO} pt-1.5 text-(--home-dim)`}>
							{index + 1}
						</span>
						{item}
					</li>
				))}
			</ol>
			<p className="mt-6 text-[15px]">
				<a
					href={LIMITATIONS_URL}
					target="_blank"
					rel="noopener noreferrer"
					className={`inline-block py-1.5 ${textLink}`}
				>
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
						<summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-6 text-lg font-medium tracking-[-0.01em] transition-colors hover:text-(--home-ink) [&::-webkit-details-marker]:hidden">
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
		<section aria-labelledby="home-closing-heading" className="relative border-t border-(--home-line)">
			<Cross className="left-0 -top-[6.5px]" />
			<Cross className="right-0 -top-[6.5px]" />
			<div className="grid lg:grid-cols-12">
				<div className={`${PAD} py-20 lg:col-span-8 lg:py-36`}>
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
				<div className="hidden items-center justify-center border-l border-(--home-line) p-10 lg:col-span-4 lg:flex">
					<HomeTowDetail className="pointer-events-none h-auto w-full max-w-[340px]" />
				</div>
			</div>
		</section>
	);
}
