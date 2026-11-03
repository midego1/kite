import type { CSSProperties } from "react";

/*
 * A detail view for the closing section: the kite's tow point magnified inside a circle, with its ring, the two
 * bridle legs, the flying line, centre lines and a diameter dimension. It draws parts only and carries no
 * specifications. Decorative and hidden from assistive technology; it traces itself in under the same CSS as
 * the hero drawing and stays still under prefers-reduced-motion.
 */

const INK = "rgb(255 255 255 / 0.55)";
const SOFT = "rgb(255 255 255 / 0.3)";
const FAINT = "rgb(255 255 255 / 0.16)";
const TEXT = "rgb(255 255 255 / 0.6)";

const delay = (seconds: number) => ({ "--d": `${seconds}s` }) as CSSProperties;

export function HomeTowDetail({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			viewBox="0 0 360 400"
			fill="none"
			strokeWidth="1.2"
			strokeLinejoin="round"
			className={className}
			style={{ fontFamily: "var(--font-geist-mono), ui-monospace, monospace" }}
		>
			<g stroke={FAINT} strokeDasharray="14 3 2 3" className="home-fade" style={delay(0.2)}>
				<path d="M180 6 V366 M14 176 H346" />
			</g>
			<circle cx="180" cy="176" r="158" stroke={INK} className="home-trace" pathLength={1} style={delay(0)} />
			<g stroke={SOFT} strokeDasharray="5 3" className="home-fade" style={delay(0.8)}>
				<path d="M88 40 L180 176 M272 40 L180 176" />
			</g>
			<g className="home-flyline" style={{ transformOrigin: "180px 176px" }}>
				<path
					d="M180 176 C 196 240, 156 290, 176 334"
					stroke={INK}
					className="home-trace"
					pathLength={1}
					style={delay(0.9)}
				/>
			</g>
			<g stroke={INK} className="home-fade" style={delay(0.7)}>
				<circle cx="180" cy="176" r="22" />
				<circle cx="180" cy="176" r="9" />
				<circle cx="88" cy="40" r="3" />
				<circle cx="272" cy="40" r="3" />
			</g>
			<g stroke={SOFT} className="home-fade" style={delay(1.2)}>
				<path d="M158 380 H202 M158 372 V388 M202 372 V388" />
				<path d="M158 380 l9 -3 v6 Z M202 380 l-9 -3 v6 Z" fill={SOFT} />
				<path d="M158 198 V372 M202 198 V372" stroke={FAINT} />
			</g>
			<g fill={TEXT} fontSize="10" stroke="none" className="home-fade" style={delay(1.4)}>
				<text x="180" y="397" textAnchor="middle">
					E
				</text>
				<text x="262" y="318">
					DETAIL A
				</text>
				<text x="262" y="332">
					TOW POINT
				</text>
				<text x="262" y="346">
					NOT TO SCALE
				</text>
			</g>
		</svg>
	);
}
