import { useId, type CSSProperties } from "react";

/*
 * The hero's and the closing section's drawing: a front view of a kite as an engineering sheet, in thin white
 * lines on the page. Centre lines, a symmetric kite (two pairs of equal sides), the spine and spar as rods,
 * hem and fabric hatching, a bridle to a tow point, dimension lines with arrowheads and ticks, numbered
 * callouts and a small title block. Labels name parts only; dimensions carry reference letters, never values.
 * Decorative, so hidden from assistive technology. The lines drawing themselves in and the flying line drifting
 * are CSS (globals.css) and stop under prefers-reduced-motion.
 */

const INK = "var(--home-draw-ink)";
const SOFT = "var(--home-draw-soft)";
const FAINT = "var(--home-draw-faint)";
const TEXT = "var(--home-draw-text)";

/** Kite corners: top, left, right, bottom of the front view. */
const TOP = [290, 80] as const;
const LEFT = [150, 230] as const;
const RIGHT = [430, 230] as const;
const BOTTOM = [290, 520] as const;
const TOW = [356, 392] as const;

const point = ([x, y]: readonly [number, number]) => `${x} ${y}`;
const OUTLINE = `M${point(TOP)} L${point(RIGHT)} L${point(BOTTOM)} L${point(LEFT)} Z`;

/** 45 degree fabric hatching across the kite's box; the clip keeps two opposite sail panels. */
const HATCH = Array.from({ length: 90 }, (_, index) => {
	const k = index * 8;
	return `M150 ${80 + k} L430 ${k - 200}`;
}).join(" ");

const arrow = (x: number, y: number, direction: "up" | "down" | "left" | "right") => {
	const shapes = {
		up: `M${x} ${y} l-3 9 h6 Z`,
		down: `M${x} ${y} l-3 -9 h6 Z`,
		left: `M${x} ${y} l9 -3 v6 Z`,
		right: `M${x} ${y} l-9 -3 v6 Z`,
	};
	return shapes[direction];
};
const tick = (x: number, y: number) => `M${x - 4} ${y + 4} l8 -8`;

const CALLOUTS = [
	{ n: 1, circle: [180, 520], target: [289, 440] },
	{ n: 2, circle: [122, 300], target: [160, 232] },
	{ n: 3, circle: [440, 336], target: [360, 320] },
	{ n: 4, circle: [402, 152], target: [326, 256] },
	{ n: 5, circle: [432, 424], target: [361, 396] },
	{ n: 6, circle: [230, 600], target: [290, 556] },
] as const;

const LEGEND = [
	["1 SPINE", "4 BRIDLE"],
	["2 SPAR", "5 TOW POINT"],
	["3 SAIL", "6 CENTRE LINE"],
];

const delay = (seconds: number) => ({ "--d": `${seconds}s` }) as CSSProperties;
const trace = (seconds: number) => ({ className: "home-trace", pathLength: 1, style: delay(seconds) });
const fade = (seconds: number) => ({ className: "home-fade", style: delay(seconds) });

export function HomeKiteArt({ className }: { className?: string }) {
	const clip = `kite-hatch-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
	return (
		<svg
			aria-hidden="true"
			viewBox="0 0 520 800"
			fill="none"
			strokeWidth="1.2"
			strokeLinejoin="round"
			className={className}
			style={{ fontFamily: "var(--font-geist-mono), ui-monospace, monospace" }}
		>
			<defs>
				<clipPath id={clip}>
					<path d="M290 80 L150 230 L290 230 Z M290 230 L430 230 L290 520 Z" />
				</clipPath>
			</defs>

			{/* Centre lines of the spine and the spar, dash-dot as on a drawing sheet. */}
			<g stroke={FAINT} strokeDasharray="14 3 2 3" {...fade(0.2)}>
				<path d="M290 48 V800" />
				<path d="M118 230 H462" />
			</g>

			{/* Fabric hatching in two opposite sail panels, then the hem. */}
			<path d={HATCH} stroke="var(--home-draw-hatch)" clipPath={`url(#${clip})`} {...fade(0.9)} />
			<path d="M290 96 L418 232 L290 502 L162 232 Z" stroke={SOFT} strokeDasharray="4 3" {...fade(0.8)} />

			{/* Sail outline, spine and spar as two-line rods. */}
			<path d={OUTLINE} stroke={INK} {...trace(0)} />
			<g stroke={INK}>
				<path d="M288.5 80 V520 M291.5 80 V520" {...trace(0.5)} />
				<path d="M150 228.5 H430 M150 231.5 H430" {...trace(0.7)} />
			</g>

			{/* Bridle legs from the spine to the tow point, with the tow ring. */}
			<g stroke={SOFT} strokeDasharray="5 3" {...fade(1.1)}>
				<path d={`M290 120 L${point(TOW)} M290 330 L${point(TOW)}`} />
			</g>
			<g stroke={INK} {...fade(1.2)}>
				<circle cx="290" cy="120" r="2.5" />
				<circle cx="290" cy="330" r="2.5" />
				<circle cx={TOW[0]} cy={TOW[1]} r="5" />
				<path d={`M${TOW[0] - 9} ${TOW[1]} h18 M${TOW[0]} ${TOW[1] - 9} v18`} />
			</g>

			{/* The flying line from the tow point drifts a little in the wind. */}
			<g className="home-flyline">
				<path d={`M${point(TOW)} C 372 470, 318 540, 344 620 S 330 690, 322 730`} stroke={INK} {...trace(1)} />
			</g>

			{/* Dimensions: overall height A and width B, then the spine in two parts C and D. */}
			<g stroke={SOFT} {...fade(1.4)}>
				<path d="M96 80 V520 M150 44 H430 M478 80 V520" />
				<path
					d={`${arrow(96, 80, "up")} ${arrow(96, 520, "down")} ${arrow(150, 44, "left")} ${arrow(430, 44, "right")}`}
					fill={SOFT}
				/>
				<path d={`${tick(478, 80)} ${tick(478, 230)} ${tick(478, 520)}`} />
			</g>
			<g stroke={FAINT} {...fade(1.4)}>
				<path d="M104 80 H282 M104 520 H282 M150 52 V222 M430 52 V222 M300 80 H484 M440 230 H484 M300 520 H484" />
			</g>
			<g fill={TEXT} fontSize="10" textAnchor="middle" stroke="none" {...fade(1.6)}>
				<text x="86" y="304" transform="rotate(-90 86 304)">
					A
				</text>
				<text x="290" y="36">
					B
				</text>
				<text x="490" y="160" textAnchor="start">
					C
				</text>
				<text x="490" y="380" textAnchor="start">
					D
				</text>
			</g>

			{/* Numbered part callouts with leader lines. */}
			<g stroke={SOFT} {...fade(1.8)}>
				{CALLOUTS.map(({ n, circle, target }) => (
					<g key={n}>
						<path d={`M${point(circle)} L${point(target)}`} />
						<circle cx={circle[0]} cy={circle[1]} r="8" fill="var(--home-bg)" />
						<circle cx={target[0]} cy={target[1]} r="1.6" fill={SOFT} stroke="none" />
						<text x={circle[0]} y={circle[1] + 3.4} fill={TEXT} fontSize="9.5" textAnchor="middle" stroke="none">
							{n}
						</text>
					</g>
				))}
			</g>

			{/* Title block. */}
			<g stroke={SOFT} {...fade(2)}>
				<path d="M24 668 H252 V776 H24 Z M24 692 H252 M24 756 H252 M138 692 V756" />
				<g fill={TEXT} fontSize="9" stroke="none">
					<text x="32" y="684">
						KITE, FRONT VIEW
					</text>
					{LEGEND.map(([left, right], row) => (
						<g key={left}>
							<text x="32" y={708 + row * 16}>
								{left}
							</text>
							<text x="146" y={708 + row * 16}>
								{right}
							</text>
						</g>
					))}
					<text x="32" y="770">
						NOT TO SCALE
					</text>
					<text x="146" y="770">
						SHEET 1 OF 1
					</text>
				</g>
			</g>
		</svg>
	);
}
