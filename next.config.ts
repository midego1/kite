import type { NextConfig } from "next";
import { getApiSecurityHeaders, getSecurityHeaders } from "./src/lib/security/headers";
import { getBuildVersion } from "./scripts/build-version.mjs";

const build = getBuildVersion();

const nextConfig: NextConfig = {
	env: {
		NEXT_PUBLIC_KITE_BUILD_VERSION: build.version,
		NEXT_PUBLIC_KITE_BUILD_COMMIT: build.commit,
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
