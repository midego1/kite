// vinext downloads the next/font/google stylesheets and font files while Vite transforms the root layout. When a
// download is rejected (a dropped connection, a DNS hiccup) it silently falls back to <link> tags for
// fonts.googleapis.com, which the app's CSP blocks: every console-error assertion in the suite then fails, and a
// production build would ship the same blocked links. Retrying the few font requests keeps the self-hosted path.

const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requestHost(input) {
	try {
		return new URL(typeof input === "string" || input instanceof URL ? input : input.url).hostname;
	} catch {
		return "";
	}
}

/** Wraps `fetch` so requests to the Google Fonts hosts are retried with a growing delay; everything else passes through. */
export function withFontFetchRetry(baseFetch, { attempts = 4, delayMs = 500, sleep = wait } = {}) {
	return async function fetchWithFontRetry(input, init) {
		if (!FONT_HOSTS.has(requestHost(input))) return baseFetch(input, init);
		for (let attempt = 1; ; attempt += 1) {
			try {
				const response = await baseFetch(input, init);
				if (!RETRYABLE_STATUS.has(response.status) || attempt >= attempts) return response;
			} catch (error) {
				if (attempt >= attempts) throw error;
			}
			await sleep(delayMs * 2 ** (attempt - 1));
		}
	};
}

const INSTALLED = Symbol.for("kite.fontFetchRetry");

/** Installs the retry on the global `fetch` once per process. */
export function installFontFetchRetry() {
	if (globalThis.fetch[INSTALLED]) return;
	const wrapped = withFontFetchRetry(globalThis.fetch.bind(globalThis));
	wrapped[INSTALLED] = true;
	globalThis.fetch = wrapped;
}
