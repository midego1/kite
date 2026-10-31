import type { Metadata } from "next";
import Link from "next/link";
import { getHomeBranding } from "./home-server-utils";
import { HomeAuthProvider } from "./home-auth";
import { HomeHeaderActions } from "./home-header-actions";
import { HomeHeroActions } from "./home-hero-actions";
import { HomeProductMock } from "./home-product-mock";
import { HomeFeatures, HomeFooter, HomeRuntime } from "./home-sections";
import { heroFacts } from "./utils";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
	const branding = await getHomeBranding();
	return {
		title: branding.appName,
		description: `${branding.appName} is a self-hosted mail suite for your own domains: a real inbox with a Screener and spam protection, your other accounts in the same place, AI that asks before it acts, and Calendar, Drive, Booking and Money Watch as modules. Open source, in your own Cloudflare account or a Docker container.`,
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
						<a href="#how-it-runs" className="transition-colors hover:text-neutral-950">
							How it runs
						</a>
					</nav>
					<div className="flex items-center gap-2">
						<HomeHeaderActions />
					</div>
				</header>

				<main id="main">
					<section aria-labelledby="home-hero-heading" className="relative overflow-hidden">
						{/* The kite's own gradient, faded far back, so the hero reads as the brand without an image. */}
						<div
							aria-hidden="true"
							className="pointer-events-none absolute left-1/2 top-0 -z-0 h-[480px] w-[900px] -translate-x-1/2 rounded-full opacity-40 blur-3xl"
							style={{ background: "radial-gradient(closest-side, #9b7bf7 0%, #7fa2ff 45%, transparent 100%)" }}
						/>
						<div className="relative mx-auto max-w-7xl px-4 pb-12 pt-10 text-center sm:px-6 md:pt-16 lg:px-8">
							<p className="mx-auto mb-5 w-fit rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-700 shadow-sm">
								Self-hosted mail suite · open source · early beta
							</p>
							<h1
								id="home-hero-heading"
								className="mx-auto max-w-5xl text-5xl font-bold leading-[1.02] tracking-tight text-neutral-950 sm:text-6xl lg:text-7xl"
							>
								Mail for your own domains, <span className="home-accent block text-blue-600">that actually flows.</span>
							</h1>
							<p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-neutral-600">
								{branding.appName} is a complete inbox for you@yourdomain: mail with a Screener and spam protection,
								your Gmail, iCloud and other IMAP accounts in the same place, AI that drafts but asks before it acts,
								and Calendar, Drive, Booking and Money Watch beside it. It runs in your own Cloudflare account or in one
								Docker container.
							</p>
							<HomeHeroActions />
							<ul className="mx-auto mt-8 flex max-w-3xl flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-neutral-600">
								{heroFacts.map((fact) => (
									<li key={fact} className="flex items-center gap-2">
										<span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-blue-500" />
										{fact}
									</li>
								))}
							</ul>
						</div>
						<div className="relative mx-auto max-w-7xl px-4 pb-8 sm:px-6 lg:px-8">
							<HomeProductMock appName={branding.appName} />
							<p className="mt-4 text-center text-xs text-neutral-500">
								The preview shows invented demo data, in the same look as the app.
							</p>
						</div>
					</section>

					<HomeFeatures appName={branding.appName} />
					<HomeRuntime appName={branding.appName} />
				</main>
				<HomeFooter appName={branding.appName} />
			</div>
		</HomeAuthProvider>
	);
}
