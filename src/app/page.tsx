import type { Metadata } from "next";
import Link from "next/link";
import { getHomeBranding } from "./home-server-utils";
import { HomeAuthProvider } from "./home-auth";
import { HomeHeaderActions } from "./home-header-actions";
import { HomeHeroActions } from "./home-hero-actions";
import { HomeProductMock } from "./home-product-mock";
import { HomeKiteArt } from "./home-kite-art";
import { HomeFeatures, HomeFooter } from "./home-sections";
import { MONO, PAGE_X } from "./home-ui";
import {
	HomeClosing,
	HomeCompare,
	HomeCost,
	HomeDeploy,
	HomeFaq,
	HomeLimits,
	HomeOpen,
	HomeProof,
} from "./home-conversion-sections";

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
 * The landing page of an install. A signed-in user keeps the page (the header shows their account and the
 * hero's first button opens the dashboard); a visitor gets the ways in. Everything but the two button groups
 * renders on the server. The page is always dark and set in Geist (.home-page in globals.css), so it looks the
 * same under every theme and style, and nothing it sets reaches the signed-in app.
 */
export default async function HomePage() {
	const branding = await getHomeBranding();
	const icon = branding.hasCustomIcon ? "/api/branding/icon" : "/kite.svg";
	const navLink = "transition-colors hover:text-(--home-ink)";

	return (
		<HomeAuthProvider>
			<div className="home-page dark min-h-dvh overflow-x-clip antialiased">
				<a
					href="#main"
					className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-(--home-ink) focus:px-5 focus:py-2 focus:text-sm focus:font-medium focus:text-(--home-bg)"
				>
					Skip to content
				</a>
				<header className={`${PAGE_X} flex h-20 items-center justify-between`}>
					<Link href="/" className="flex items-center gap-3" aria-label={`${branding.appName} home`}>
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

				<main id="main">
					<section aria-labelledby="home-hero-heading" className="relative overflow-x-clip">
						<HomeKiteArt className="pointer-events-none absolute -right-24 top-0 h-[520px] w-auto opacity-40 sm:right-[-4%] md:right-0 md:h-[700px] md:opacity-60 xl:opacity-100" />
						<div className={`${PAGE_X} relative pb-16 pt-14 md:pt-24 lg:pb-24`}>
							<h1
								id="home-hero-heading"
								className="home-rise max-w-[17em] text-balance text-[clamp(2.5rem,6.2vw,5.5rem)] font-medium leading-[1] tracking-[-0.04em]"
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
									Routing and sends through Cloudflare, Resend or Amazon SES. Your mail stays in your D1 database and R2
									bucket (SQLite and local files with Docker). Every feature is free.
								</p>
								<div className="home-rise mt-9" style={{ "--home-delay": "260ms" } as React.CSSProperties}>
									<HomeHeroActions />
									<p className="mt-6 max-w-sm text-sm leading-6 text-(--home-dim)">
										Needs a Cloudflare account with a domain on Cloudflare DNS. Plan on about 10 minutes the first time.
									</p>
									<p className={`${MONO} mt-5 text-(--home-dim)`}>Open source · AGPL-3.0 · Early beta</p>
								</div>
							</div>
						</div>
						<div className={`${PAGE_X} relative pb-20 lg:pb-32`}>
							<div className="mb-4 flex flex-col gap-1 lg:flex-row lg:items-baseline lg:justify-between">
								<h2 className={`${MONO} flex items-center gap-2 text-(--home-ink)`}>
									<span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-(--home-signal)" />
									Try it — it&apos;s a live demo
								</h2>
								<p className="text-xs leading-5 text-(--home-dim)">
									The demo shows invented data, in the same look as the app. Nothing you do here leaves this page.
								</p>
							</div>
							<HomeProductMock appName={branding.appName} />
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
		</HomeAuthProvider>
	);
}
