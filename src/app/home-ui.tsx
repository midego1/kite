/* Shared classes of the home page's chrome. The colours are the app's own (the neutral and blue scales that the
   theme remaps), so the page looks like the product in light and in dark. */

export const MONO = "font-(family-name:--font-geist-mono) text-[13px] tracking-[0.02em]";

const BUTTON =
	"inline-flex h-9 items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 pointer-coarse:h-11";

/** The filled action of the chrome: Deploy to Cloudflare, Open dashboard. */
export const ctaPrimary = `${BUTTON} bg-blue-600 px-3 text-white hover:bg-blue-700 sm:px-4`;
/** The quiet actions: Sign in, View on GitHub. */
export const ctaGhost = `${BUTTON} border border-neutral-200 px-3 text-neutral-800 hover:bg-neutral-100 sm:px-4`;
