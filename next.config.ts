import type { NextConfig } from "next";
import { getApiSecurityHeaders, getSecurityHeaders } from "./src/lib/security/headers";
import { getBuildVersion } from "./scripts/build-version.mjs";

const build = getBuildVersion();

const nextConfig: NextConfig = {
	env: {
		NEXT_PUBLIC_KITE_BUILD_VERSION: build.version,
		NEXT_PUBLIC_KITE_BUILD_COMMIT: build.commit,
		NEXT_PUBLIC_KITE_BUILD_TIME: build.builtAt,
	},
	distDir: process.env.KITE_RUNTIME === "node" ? ".next-node" : undefined,
	turbopack: {
		root: import.meta.dirname,
		resolveAlias:
			process.env.KITE_RUNTIME === "node"
				? {
						"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
					}
				: {},
	},
	allowedDevOrigins: ["mail.dev"],
	experimental: {
		serverActions: {
			// Kite has no server actions, but `vite dev` treats every multipart POST without an action id as one
			// and caps it at this size before route handlers (uploads, restore) apply their own limits. Production
			// builds skip that gate when no "use server" code exists. 100 MB is the Workers request body limit.
			bodySizeLimit: "100mb",
		},
	},
	typescript: {
		ignoreBuildErrors: false,
	},
	// Native and server-only packages used by the self-hosted runtime; never bundle them.
	serverExternalPackages: ["better-sqlite3", "nodemailer", "smtp-server", "ws"],
	async headers() {
		return [
			{
				source: "/(.*)",
				headers: getSecurityHeaders(),
			},
			// Documents get a nonce-based policy per request from worker.ts / server/index.ts.
			...["/api/(.*)", "/jmap/(.*)", "/mcp", "/.well-known/(.*)"].map((source) => ({
				source,
				headers: getApiSecurityHeaders(),
			})),
		];
	},
};

export default nextConfig;
