export const MAIN_CONTENT_ID = "main-content";

/** The first tab stop of every signed-in layout; hidden until it takes focus. */
export function SkipToContent() {
	return (
		<a
			href={`#${MAIN_CONTENT_ID}`}
			className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[130] focus:rounded-full focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-blue-700 focus:shadow-lg focus:ring-2 focus:ring-blue-600"
		>
			Skip to main content
		</a>
	);
}
