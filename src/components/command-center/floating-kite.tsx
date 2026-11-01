import { KiteGlyph } from "@/components/kite-glyph";

/**
 * The kite in the corner of the empty reading pane: the logo kite with its tail (kite-glyph.tsx), moved by CSS
 * alone (`command-center-float` in globals.css) and still under reduced motion. Decorative only, and quiet: no
 * glow, a little larger than the sidebar's logo so the hero has a counterweight.
 */
export function FloatingKite() {
	return (
		<div aria-hidden="true" data-command-center-kite className="pointer-events-none absolute right-8 top-6 w-14">
			<svg className="command-center-kite block h-auto w-full" viewBox="-20 0 136 170" fill="none">
				<KiteGlyph fillId="command-center-fill" tailClassName="command-center-tail" />
			</svg>
		</div>
	);
}
