import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";
import { getBuildVersion } from "./scripts/build-version.mjs";
import { installFontFetchRetry } from "./scripts/font-fetch-retry.mjs";

const build = getBuildVersion();
// vinext fetches the next/font/google files in this process while it transforms the root layout.
installFontFetchRetry();
const DEV_ONLY_VARS = [
	"ALERT_WEBHOOK_ALLOW_INSECURE",
	"AI_ALLOW_INSECURE_LOOPBACK",
	"AI_TEST_TIMEOUT_MS",
	"REMOTE_IMAGES_ALLOW_LOOPBACK",
	// Lets e2e/108-mailing-list-notice.spec.ts send the one-click unsubscribe POST to its receiver on 127.0.0.1.
	"UNSUBSCRIBE_ALLOW_LOOPBACK",
	"STORAGE_ALLOW_INSECURE_ENDPOINT",
	"ABUSE_CH_TEST_ORIGIN",
	// Let e2e/93-storage-r2-auto-setup.spec.ts send the automatic R2 setup to its fake Cloudflare API and fake R2.
	"CLOUDFLARE_API_TEST_ORIGIN",
	"R2_S3_TEST_ENDPOINT",
	// Lets e2e/60-imap-import.spec.ts import from the fake IMAP server on 127.0.0.1 without TLS.
	"EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK",
	// Lets e2e/100-microsoft-oauth.spec.ts send Microsoft sign-in to its fake OAuth server on 127.0.0.1.
	"EXTERNAL_OAUTH_TEST_ORIGIN",
	"DATABASE_SIZE_TEST_HEADER",
	// Lets scripts/attachment-storage-check.mjs kill an attachment storage job part way.
	"ATTACHMENT_STORAGE_TEST_HOOKS",
	// The e2e server points it at a loopback port where nothing listens; deployments set it as a variable.
	"KITE_TELEMETRY_URL",
	// Only so the e2e server can save storage credentials; a real install sets it as a secret or in .dev.vars.
	"APP_ENCRYPTION_KEY",
	// `wrangler dev` has no local Vectorize emulation without remote access; this switches search by meaning to the
	// D1-backed brute-force test store for npm run dev and e2e.
	"SEMANTIC_TEST_STORE",
] as const;

export default defineConfig(({ command }) => ({
	define: {
		"process.env.NEXT_PUBLIC_KITE_BUILD_VERSION": JSON.stringify(build.version),
		"process.env.NEXT_PUBLIC_KITE_BUILD_COMMIT": JSON.stringify(build.commit),
		"process.env.NEXT_PUBLIC_KITE_BUILD_TIME": JSON.stringify(build.builtAt),
	},
	// node_modules can be shared between checkouts; a separate cache keeps concurrent dev servers from re-optimizing each other's deps.
	...(process.env.KITE_VITE_CACHE_DIR ? { cacheDir: process.env.KITE_VITE_CACHE_DIR } : {}),
	server: { allowedHosts: ["kite.local", "mail.dev"] },
	plugins: [
		vinext({ images: { optimizer: imagesOptimizer() } }),
		cloudflare({
			remoteBindings: process.env.CLOUDFLARE_REMOTE_BINDINGS === "true",
			// The E2E suite points this at a throwaway directory so it never touches .wrangler/state.
			...(process.env.KITE_PERSIST_DIR ? { persistState: { path: process.env.KITE_PERSIST_DIR } } : {}),
			...(process.env.KITE_NO_INSPECTOR ? { inspectorPort: false as const } : {}),
			viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
			// The customizer also runs for `vite build`, which would bake the flags into dist/server/wrangler.json.
			config: () => {
				if (command !== "serve") return;
				const vars = Object.fromEntries(
					DEV_ONLY_VARS.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])),
				);
				if (Object.keys(vars).length) return { vars };
			},
		}),
	],
}));
