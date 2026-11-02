/**
 * Kite's mark drawn as line art for the hero: a hairline kite with its spars, a string that draws itself in
 * and a few bows on the tail. Decorative, so hidden from assistive technology; the sway and the draw-in are
 * CSS (globals.css) and stop under prefers-reduced-motion.
 */
export function HomeKiteArt({ className }: { className?: string }) {
	const line = { vectorEffect: "non-scaling-stroke" } as const;
	return (
		<svg aria-hidden="true" viewBox="0 0 520 780" fill="none" className={className}>
			<g className="home-kite" stroke="rgb(255 255 255 / 0.3)" strokeWidth="1" strokeLinejoin="round">
				<path d="M290 20 L430 210 L290 480 L150 210 Z" {...line} />
				<path d="M290 20 L290 480 M150 210 L430 210" {...line} />
				<path d="M290 20 L360 210 L290 480 M290 20 L220 210 L290 480" stroke="rgb(255 255 255 / 0.12)" {...line} />
				<circle cx="290" cy="210" r="3" fill="#8fb0ff" stroke="none" />
				<path
					className="home-string"
					d="M290 480 C 262 560, 352 610, 306 690 S 232 758, 252 776"
					pathLength="1"
					stroke="rgb(255 255 255 / 0.3)"
					{...line}
				/>
				<g stroke="rgb(255 255 255 / 0.3)">
					<path d="M276 540 l8 -6 l8 6 l-8 6 Z" {...line} />
					<path d="M326 610 l8 -6 l8 6 l-8 6 Z" {...line} />
					<path d="M296 678 l8 -6 l8 6 l-8 6 Z" {...line} />
				</g>
			</g>
		</svg>
	);
}
