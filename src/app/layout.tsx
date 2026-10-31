import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono, Inter, Manrope, Ms_Madi } from "next/font/google";
import { Providers } from "@/components/providers";
import { legacyStorageMigrationScript } from "@/components/legacy-storage-utils";
import { sidebarBootstrapScript } from "@/components/sidebar-state-utils";
import { themeBootstrapScript } from "@/components/theme-utils";
import { appearanceBootstrapScript } from "@/components/appearance-preferences";
import { assetRecoveryScript } from "@/components/asset-recovery-utils";
import { bootTraceScript } from "@/components/boot-trace-utils";
import { reloadReturnBootstrapScript } from "@/components/reload-return-utils";
import { getHomeBranding } from "./home-server-utils";
import "./globals.css";

const geistSans = Geist({
	variable: "--font-geist-sans",
	subsets: ["latin"],
});

const geistMono = Geist_Mono({
	variable: "--font-geist-mono",
	subsets: ["latin"],
});

const manrope = Manrope({
	variable: "--font-manrope",
	subsets: ["latin"],
});

const inter = Inter({
	variable: "--font-inter",
	subsets: ["latin"],
});

const kiteScript = Ms_Madi({
	variable: "--font-kite-script",
	subsets: ["latin"],
	weight: "400",
});

const baseMetadata: Metadata = {
	description: "Multi-tenant email on Cloudflare",
	icons: { icon: "/api/branding/icon" },
	robots: {
		index: false,
		follow: false,
		noarchive: true,
		nosnippet: true,
		noimageindex: true,
		googleBot: {
			index: false,
			follow: false,
			noarchive: true,
			nosnippet: true,
			noimageindex: true,
		},
	},
};

/** The configured app name is the title of the first response, so it is not swapped in after the page loads. */
export async function generateMetadata(): Promise<Metadata> {
	const { appName } = await getHomeBranding();
	return { ...baseMetadata, title: appName };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
	const nonce = (await headers()).get("x-nonce") ?? undefined;
	const branding = await getHomeBranding();
	return (
		<html
			lang="en"
			data-style="kite"
			className={`${geistSans.variable} ${geistMono.variable} ${manrope.variable} ${inter.variable} ${kiteScript.variable}`}
			suppressHydrationWarning
		>
			<head>
				{/* First, so the boot trace and the watchdog are listening before the app's entry script is parsed. */}
				<script nonce={nonce} dangerouslySetInnerHTML={{ __html: bootTraceScript }} />
				<script
					nonce={nonce}
					dangerouslySetInnerHTML={{
						__html: assetRecoveryScript({ dev: process.env.NODE_ENV !== "production" }),
					}}
				/>
				<script nonce={nonce} dangerouslySetInnerHTML={{ __html: legacyStorageMigrationScript }} />
				<script nonce={nonce} dangerouslySetInnerHTML={{ __html: sidebarBootstrapScript }} />
				<script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
				{/* After the theme, so the kite's return (reload-return-utils.ts) paints in the right colours from the first frame. */}
				<script nonce={nonce} dangerouslySetInnerHTML={{ __html: reloadReturnBootstrapScript }} />
				<script nonce={nonce} dangerouslySetInnerHTML={{ __html: appearanceBootstrapScript }} />
				<link rel="icon" href="/api/branding/icon"></link>
			</head>
			<body className="antialiased">
				<Providers initialBranding={branding}>{children}</Providers>
			</body>
		</html>
	);
}
