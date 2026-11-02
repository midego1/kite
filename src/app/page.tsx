import type { Metadata } from "next";
import Link from "next/link";
import { MousePointerClick } from "lucide-react";
import { getHomeBranding } from "./home-server-utils";
import { HomeAuthProvider } from "./home-auth";
import { HomeHeaderActions } from "./home-header-actions";
import { HomeHeroActions } from "./home-hero-actions";
import { HomeProductMock } from "./home-product-mock";
import { HomeFeatures, HomeFooter } from "./home-sections";
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
		description: `${branding.appName} is a self-hosted webmail app on Cloudflare Workers. It receives through Email Routing and sends through Cloudflare, Resend or Amazon SES. Your mail stays in your D1 database and R2 bucket. Every feature is free. Early beta.`,
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
 * renders on the server, and the colours are the app's own palette, so the page follows the style and the
 * dark theme like every other screen (globals.css remaps the neutral and blue scales under .dark).
 */
export default async function HomePage() {
	const branding = await getHomeBranding();
	const icon = branding.hasCustomIcon ? "/api/branding/icon" : "/kite.svg";

	return (
		<HomeAuthProvider>
			<div className="min-h-dvh bg-[#f6f8fc] text-neutral-900">
				<a
					href="#main"
					className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow"
				>
					Skip to content
				</a>
				<header className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
					<Link href="/" className="flex items-center gap-3" aria-label={`${branding.appName} home`}>
						<img src={icon} height={32} width={32} alt="" />
						<span className="text-lg font-bold tracking-tight">{branding.appName}</span>
					</Link>
					<nav
						aria-label="Page sections"
						className="hidden items-center gap-6 text-sm font-medium text-neutral-600 md:flex"
					>
						<a href="#features" className="transition-colors hover:text-neutral-950">
							Features
						</a>
						<a href="#deploy" className="transition-colors hover:text-neutral-950">
							Deploy
						</a>
						<a href="#cost" className="transition-colors hover:text-neutral-950">
							Cost
						</a>
						<a href="#compare" className="transition-colors hover:text-neutral-950">
							Compare
						</a>
						<a href="#faq" className="transition-colors hover:text-neutral-950">
							FAQ
						</a>
					</nav>
					<div className="flex items-center gap-2">
						<HomeHeaderActions />
					</div>
				</header>

				<main id="main">
					<section aria-labelledby="home-hero-heading" className="relative overflow-hidden">
						<div className="relative mx-auto max-w-7xl px-4 pb-8 pt-10 text-center sm:px-6 md:pt-16 lg:px-8">
							<p className="mx-auto mb-5 w-fit rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-700 shadow-sm">
								Open source · AGPL-3.0 · Early beta
							</p>
							<h1
								id="home-hero-heading"
								className="mx-auto max-w-5xl text-4xl font-bold leading-[1.08] tracking-tight text-neutral-950 sm:text-5xl lg:text-6xl"
							>
								Your own inbox for your own domains,{" "}
								<span className="home-accent text-blue-600">running in your Cloudflare account.</span>
							</h1>
							<p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-neutral-600">
								{branding.appName} is a self-hosted webmail app on Cloudflare Workers. It receives through Email Routing
								and sends through Cloudflare, Resend or Amazon SES. Your mail stays in your D1 database and R2 bucket.
								Every feature is free.
							</p>
							<HomeHeroActions />
							<p className="mx-auto mt-4 max-w-xl text-sm text-neutral-500">
								Needs a Cloudflare account with a domain on Cloudflare DNS. Plan on about 10 minutes the first time.
							</p>
						</div>
						<div className="relative mx-auto max-w-7xl px-4 pb-8 sm:px-6 lg:px-8">
							<p className="mb-3 flex items-center justify-center gap-2 text-sm font-medium text-neutral-700">
								<MousePointerClick className="h-4 w-4 text-blue-500" aria-hidden="true" />
								Try it — it&apos;s a live demo
							</p>
							<HomeProductMock appName={branding.appName} />
							<p className="mt-4 text-center text-xs text-neutral-500">
								The demo shows invented data, in the same look as the app. Nothing you do here leaves this page.
							</p>
						</div>
					</section>

					<HomeProof />
					<HomeFeatures appName={branding.appName} />
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
