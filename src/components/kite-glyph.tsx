import type { KiteGlyphProps } from "./kite-glyph-types";

/**
 * The logo kite (public/kite.svg) with its tail, as the children of an `<svg>` whose viewBox includes
 * `-20 0 136 170`: the diamond spans x 11 to 85 and y 5 to 91, the tail trails from the lower tip (28, 91) down
 * to about (-14, 166). Shared by the flight out (reload-flight.tsx) and the return (reload-return-scene.tsx), so
 * the kite that leaves is the one that comes back. `fillId` keeps the gradient ids apart when both are in a page.
 */
export function KiteGlyph({ fillId, tailClassName }: KiteGlyphProps) {
	const fill = `url(#${fillId})`;
	return (
		<>
			<defs>
				<linearGradient id={fillId} x1="14" y1="8" x2="80" y2="88" gradientUnits="userSpaceOnUse">
					<stop stopColor="#7fa2ff" />
					<stop offset="1" stopColor="#9b7bf7" />
				</linearGradient>
			</defs>
			{/* The tail trails from the kite's lower tip and sways on its own, slightly behind the kite. */}
			<g className={tailClassName} stroke="#9b7bf7" strokeWidth="2.5" strokeLinecap="round">
				<path d="M28 91 C 20 108, 4 112, -2 134 S -10 158, -14 166" opacity="0.8" />
				<path d="M12 112 l-8 -6 M12 112 l-9 4" />
				<path d="M-2 134 l-8 -5 M-2 134 l-9 5" />
				<path d="M-10 156 l-8 -5 M-10 156 l-8 5" />
			</g>
			<path d="M62 5 L85 50 L28 91 L11 25 Z" fill={fill} stroke={fill} strokeWidth="3" strokeLinejoin="round" />
			<path d="M62 5 L11 25 L49 37.9 Z" fill="#ffffff" fillOpacity="0.14" />
			<path d="M85 50 L28 91 L49 37.9 Z" fill="#4f46e5" fillOpacity="0.12" />
			<path d="M11 25 L85 50 M62 5 L28 91" stroke="#ffffff" strokeWidth="3.5" strokeLinecap="round" />
		</>
	);
}
