import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";
import { getBuildVersion } from "./scripts/build-version.mjs";

const build = getBuildVersion();
const DEV_ONLY_VARS = [
	"ALERT_WEBHOOK_ALLOW_INSECURE",
	"AI_ALLOW_INSECURE_LOOPBACK",
	"AI_TEST_TIMEOUT_MS",
	"REMOTE_IMAGES_ALLOW_LOOPBACK",
	"STORAGE_ALLOW_INSECURE_ENDPOINT",
	"ABUSE_CH_TEST_ORIGIN",
	// Lets e2e/60-imap-import.spec.ts import from the fake IMAP server on 127.0.0.1 without TLS.
	"EXTERNAL_ACCOUNTS_ALLOW_INSECURE_LOOPBACK",
	"DATABASE_SIZE_TEST_HEADER",
	// The e2e server points it at a `.invalid` host so it never posts usage statistics; deployments set it as a variable.
	"KITE_TELEMETRY_URL",
	// Only so the e2e server can save storage credentials; a real install sets it as a secret or in .dev.vars.
	"APP_ENCRYPTION_KEY",
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
