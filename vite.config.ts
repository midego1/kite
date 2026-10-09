import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";
import { getBuildVersion } from "./scripts/build-version.mjs";

const build = getBuildVersion();

export default defineConfig(({ command }) => ({
	define: {
		"process.env.NEXT_PUBLIC_KITE_BUILD_VERSION": JSON.stringify(build.version),
		"process.env.NEXT_PUBLIC_KITE_BUILD_COMMIT": JSON.stringify(build.commit),
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
			// The customizer also runs for `vite build`, which would bake the flag into dist/server/wrangler.json.
			config: () => {
				const allowInsecure = process.env.ALERT_WEBHOOK_ALLOW_INSECURE;
				if (command === "serve" && allowInsecure) return { vars: { ALERT_WEBHOOK_ALLOW_INSECURE: allowInsecure } };
			},
		}),
	],
}));
