import type { Metadata } from "next";
import Link from "next/link";
import { getHomeBranding } from "./home-server-utils";
import { HomeAuthProvider } from "./home-auth";
import { HomeHeaderActions } from "./home-header-actions";
import { HomeHeroActions } from "./home-hero-actions";
import { HomeProductMock } from "./home-product-mock";
import { HomeKiteArt } from "./home-kite-art";
import { HomeFeatures, HomeFooter } from "./home-sections";
import { Cross, MONO, PAD, SHEET } from "./home-ui";
import { HomeClosing, HomeFaq, HomeLimits, HomeOpen, HomeProof } from "./home-conversion-sections";
import { HomeCompare } from "./home-compare-sections";
import { HomeCost, HomeDeploy } from "./home-deploy-sections";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
	const branding = await getHomeBranding();
	return {
		title: branding.appName,
		description: `${branding.appName} is a self-hosted webmail app on Cloudflare Workers. It receives through Email Routing and sends through Cloudflare, Resend or Amazon SES. Your mail stays in your D1 database and R2 bucket (SQLite and local files with Docker). Every feature is free. Early beta.`,
		keywords: [
			"cloudflare",
			"cloudflare-workers",
			"d1",
			"email",
			"email-client",
			"jmap",
			"nextjs",
			"r2",
			"self-hosted",
			"webmail",
		],
		icons: { icon: branding.hasCustomIcon ? "/api/branding/icon" : "/icon-96.png" },
	};
}

/*
 * The landing page of an install, laid out as one engineering drawing sheet. A signed-in user keeps the page (the
 * header shows their account and the hero's first button opens the dashboard); a visitor gets the ways in.
 * Everything but the two button groups renders on the server. The page is always dark and set in Geist
 * (.home-page in globals.css), so it looks the same under every theme and style, and nothing it sets reaches the
 * signed-in app.
 */
const ZONES = Array.from({ length: 12 }, (_, index) => index + 1);
const BRACKET = "pointer-events-none absolute h-4 w-4 border-(--home-line-strong)";

export default async function HomePage() {
	const branding = await getHomeBranding();
	const icon = branding.hasCustomIcon ? "/api/branding/icon" : "/kite.svg";
	const navLink = "py-1 transition-colors hover:text-(--home-ink)";

	return (
		<HomeAuthProvider>
			<div className="home-page dark min-h-dvh overflow-x-clip antialiased sm:px-6">
				<div className={SHEET}>
					<a
						href="#main"
						className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-(--home-ink) focus:px-5 focus:py-2 focus:text-sm focus:font-medium focus:text-(--home-bg)"
					>
						Skip to content
					</a>
					<header className={`${PAD} flex h-20 items-center justify-between`}>
						<Link href="/" className="flex items-center gap-3 py-2" aria-label={`${branding.appName} home`}>
							<img src={icon} height={28} width={28} alt="" />
							<span className="text-lg font-medium tracking-[-0.02em]">{branding.appName}</span>
						</Link>
						<nav aria-label="Page sections" className="hidden items-center gap-8 text-sm text-(--home-mute) lg:flex">
							<a href="#features" className={navLink}>
								Features
							</a>
							<a href="#deploy" className={navLink}>
								Deploy
							</a>
							<a href="#cost" className={navLink}>
								Cost
							</a>
							<a href="#compare" className={navLink}>
								Compare
							</a>
							<a href="#faq" className={navLink}>
								FAQ
							</a>
						</nav>
						<div className="flex items-center gap-1 sm:gap-2">
							<HomeHeaderActions />
						</div>
					</header>
					<div aria-hidden="true" className="relative hidden grid-cols-12 border-t border-(--home-line) md:grid">
						<Cross className="left-0 -top-[6.5px]" />
						<Cross className="right-0 -top-[6.5px]" />
						{ZONES.map((zone) => (
							<span
								key={zone}
								className={`${MONO} border-l border-(--home-line) px-2 py-1 text-(--home-dim) first:border-l-0`}
							>
								{zone}
							</span>
						))}
					</div>

					<main id="main">
						<section
							aria-labelledby="home-hero-heading"
							className="relative border-t border-(--home-line) lg:grid lg:grid-cols-[minmax(0,1fr)_auto]"
						>
							<div className={`${PAD} relative z-10 pb-10 pt-14 md:pt-20 lg:pb-24`}>
								<h1
									id="home-hero-heading"
									className="home-rise max-w-[17em] text-balance text-[clamp(2.5rem,6.2vw,5.5rem)] lg:text-[clamp(2.5rem,5.4vw,5.25rem)] font-medium leading-[1] tracking-[-0.04em]"
								>
									Your own inbox for your own domains,{" "}
									<span className="text-(--home-dim)">running in your Cloudflare account.</span>
								</h1>
								<div className="mt-12 max-w-xl md:mt-16">
									<p
										className="home-rise text-pretty text-lg leading-8 text-(--home-mute)"
										style={{ "--home-delay": "140ms" } as React.CSSProperties}
									>
										{branding.appName} is a self-hosted webmail app on Cloudflare Workers. It receives through Email
										Routing and sends through Cloudflare, Resend or Amazon SES. Your mail stays in your D1 database and
										R2 bucket (SQLite and local files with Docker). Every feature is free.
									</p>
									<div className="home-rise mt-9" style={{ "--home-delay": "260ms" } as React.CSSProperties}>
										<HomeHeroActions />
										<p className="mt-6 max-w-sm text-sm leading-6 text-(--home-dim)">
											Needs a Cloudflare account with a domain on Cloudflare DNS. Plan on about 10 minutes the first
											time.
										</p>
										<p className={`${MONO} mt-5 text-(--home-dim)`}>Open source · AGPL-3.0 · Early beta</p>
									</div>
								</div>
							</div>
							{/* The drawing: below the text on a phone and a tablet, in its own column from lg so the headline can never reach it. It is as tall as the first screen allows, and its centre line carries on down the sheet. */}
							<div
								aria-hidden="true"
								className="pointer-events-none relative mx-auto mb-16 w-fit lg:m-0 lg:flex lg:flex-col"
							>
								<HomeKiteArt className="block h-[460px] w-auto lg:h-[clamp(420px,calc(100svh-9.5rem),480px)] min-[1200px]:h-[clamp(420px,calc(100svh-9.5rem),620px)] xl:h-[clamp(440px,calc(100svh-9.5rem),720px)]" />
								<span className="ml-[55.77%] hidden w-0 flex-1 border-l border-dashed border-(--home-line-strong) lg:block" />
							</div>
						</section>

						<section aria-labelledby="home-demo-heading" className="relative border-t border-(--home-line)">
							<Cross className="left-0 -top-[6.5px]" />
							<Cross className="right-0 -top-[6.5px]" />
							<div className={`${PAD} pb-20 pt-10 lg:pb-32`}>
								<div className="mb-5 flex flex-col gap-1 lg:flex-row lg:items-baseline lg:justify-between">
									<h2 id="home-demo-heading" className={`${MONO} flex items-center gap-2 text-(--home-ink)`}>
										<span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-(--home-signal)" />
										Try it — it&apos;s a live demo
									</h2>
									<p className="text-xs leading-5 text-(--home-dim)">
										The demo shows invented data, in the same look as the app. Nothing you do here leaves this page.
									</p>
								</div>
								<div className="relative">
									<span aria-hidden="true" className={`${BRACKET} -left-2 -top-2 border-l border-t`} />
									<span aria-hidden="true" className={`${BRACKET} -right-2 -top-2 border-r border-t`} />
									<span aria-hidden="true" className={`${BRACKET} -bottom-2 -left-2 border-b border-l`} />
									<span aria-hidden="true" className={`${BRACKET} -bottom-2 -right-2 border-b border-r`} />
									<HomeProductMock appName={branding.appName} />
								</div>
							</div>
						</section>

						<HomeProof />
						<HomeFeatures />
						<HomeDeploy appName={branding.appName} />
						<HomeCost appName={branding.appName} />
						<HomeCompare appName={branding.appName} />
						<HomeOpen />
						<HomeLimits />
						<HomeFaq />
						<HomeClosing appName={branding.appName} />
					</main>
					<HomeFooter appName={branding.appName} />
				</div>
			</div>
		</HomeAuthProvider>
	);
}
