import type { CloudflareTokenOutcome, SetupRequirementCheck } from "./types";

/**
 * The Deploy to Cloudflare button offers the value from .dev.vars.example as the default, so a
 * deploy that keeps it would encrypt provider keys with a value anyone can read in the repository.
 */
const EXAMPLE_ENCRYPTION_KEYS: ReadonlySet<string> = new Set(["a-long-random-string"]);
const MIN_ENCRYPTION_KEY_LENGTH = 16;

const DEPLOYMENT_DOCS = "https://github.com/midego1/kite/blob/main/docs/deployment.md";

type CheckInput = {
	env: {
		APP_ENCRYPTION_KEY?: string;
		APP_URL?: string;
	};
	/** Where this request was served from, for example `https://kite.example.workers.dev`. */
	origin?: string;
	production: boolean;
};

export function checkEncryptionKey({ env, production }: Pick<CheckInput, "env" | "production">): SetupRequirementCheck {
	const key = env.APP_ENCRYPTION_KEY?.trim();
	const name = "Encryption key (APP_ENCRYPTION_KEY)";
	if (!key) {
		return {
			key: name,
			configured: false,
			severity: "recommended",
			message: `Not set, so provider keys and webhook secrets are stored as plain text in D1. Add a long random string (for example from \`openssl rand -hex 32\`) as the secret APP_ENCRYPTION_KEY under the Worker's Settings → Variables and secrets, and keep a copy: changing it later makes stored keys unreadable. See ${DEPLOYMENT_DOCS}#step-2-deploy-kite.`,
		};
	}
	if (EXAMPLE_ENCRYPTION_KEYS.has(key) || key.length < MIN_ENCRYPTION_KEY_LENGTH) {
		return {
			key: name,
			configured: false,
			// Nothing is encrypted yet while setup runs, so replacing the key now loses nothing.
			severity: production ? "required" : "recommended",
			message: `APP_ENCRYPTION_KEY is the example value or shorter than ${MIN_ENCRYPTION_KEY_LENGTH} characters, so anyone could derive it. Replace it with a long random string (for example from \`openssl rand -hex 32\`) before continuing; this is safe now because Kite has not stored any provider keys yet.`,
		};
	}
	return { key: name, configured: true, message: "" };
}

export function checkAppUrl({ env, origin }: Pick<CheckInput, "env" | "origin">): SetupRequirementCheck {
	const name = "Public address (APP_URL)";
	const configuredUrl = env.APP_URL?.trim();
	const suggestion = origin ?? "https://your-app-address";
	if (!configuredUrl) {
		return {
			key: name,
			configured: false,
			severity: "recommended",
			message: `Not set. Password reset emails, and receiving through Resend or Amazon SES, need it. Add the variable APP_URL=${suggestion} under the Worker's Settings → Variables and secrets.`,
		};
	}
	let parsed: URL;
	try {
		parsed = new URL(configuredUrl);
	} catch {
		return {
			key: name,
			configured: false,
			severity: "recommended",
			message: `APP_URL is not a valid address (${configuredUrl}). Use the full address including https://, for example APP_URL=${suggestion}.`,
		};
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
	if (parsed.protocol !== "https:" && !loopback) {
		return {
			key: name,
			configured: false,
			severity: "recommended",
			message: `APP_URL should start with https:// (it is ${configuredUrl}). Password reset links and provider callbacks need a public HTTPS address.`,
		};
	}
	if (origin && parsed.origin !== new URL(origin).origin) {
		return {
			key: name,
			configured: false,
			severity: "recommended",
			message: `APP_URL (${parsed.origin}) is not the address you opened this page at (${origin}). If that is on purpose, ignore this; otherwise the MCP endpoint will refuse requests from this address. Set APP_URL=${origin} to match.`,
		};
	}
	return { key: name, configured: true, message: "" };
}

/**
 * Email Routing rules and the Worker's binding to itself use the name `kite`. Workers on
 * workers.dev are served from `<name>.<account>.workers.dev`, so a different first label means a
 * different name. Custom domains and Preview URLs (`<branch>-kite.…`) cannot be judged this way.
 */
export function checkWorkerName({ origin }: Pick<CheckInput, "origin">): SetupRequirementCheck | null {
	if (!origin) return null;
	const { hostname } = new URL(origin);
	if (!hostname.endsWith(".workers.dev")) return null;
	const label = hostname.split(".")[0];
	if (label === "kite" || label.endsWith("-kite")) {
		return { key: "Worker name", configured: true, message: "" };
	}
	return {
		key: "Worker name",
		configured: false,
		severity: "recommended",
		message: `This Worker looks like it is named "${label}", but it must be named exactly "kite": Email Routing rules and the Worker's binding to itself use that name, so receiving mail will not work. Redeploy it as "kite" (the deploy button's app name field). Ignore this if "${label}" is only a Preview.`,
	};
}

export function checkCloudflareTokenResult(outcome: CloudflareTokenOutcome): SetupRequirementCheck {
	const name = "Cloudflare token works";
	switch (outcome.kind) {
		case "ok":
			return { key: name, configured: true, message: "" };
		case "no_zones":
			return {
				key: name,
				configured: false,
				severity: "recommended",
				message: `The token is valid but cannot see any zone. Under Zone Resources, include the zones you will connect, then check again.`,
			};
		case "rejected":
			return {
				key: name,
				configured: false,
				severity: "required",
				message: `Cloudflare rejected CF_TOKEN (${outcome.detail}). Paste only the token secret (no "Bearer", not the token ID), create it under Manage Account → Account API Tokens with DNS: Edit, Zone: Read, Zone Settings: Edit and Email Routing Rules: Edit, then redeploy or update the secret. Steps: ${DEPLOYMENT_DOCS}#step-1-set-up-cf_token.`,
			};
		case "unreachable":
			return {
				key: name,
				configured: false,
				severity: "recommended",
				message: `Could not check CF_TOKEN against Cloudflare (${outcome.detail}). Try again in a moment.`,
			};
		default: {
			const unreachable: never = outcome;
			return unreachable;
		}
	}
}

/** Required checks that are not met; recommended ones only warn. */
export function hasBlockingFailure(checks: SetupRequirementCheck[]): boolean {
	return checks.some((check) => !check.configured && check.severity !== "recommended");
}
