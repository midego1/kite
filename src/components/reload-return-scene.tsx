import { KiteGlyph } from "./kite-glyph";

/**
 * The startup screen's sequel to the kite's flight out (reload-flight.tsx): after a reload to a new version the
 * kite flies back in from the top right and floats on its string above the progress bar, its tail rippling, with
 * a soft cloud and a few wind lines drifting by, until the app is ready and the screen fades out. Server-rendered
 * in LoadingTransition and shown only while <html> carries RELOAD_RETURN_CLASS (reload-return-utils.ts), which the
 * inline script sets before the first paint; everything moves by CSS alone (`reload-return-*` in globals.css), so
 * it runs before any chunk arrives and adds nothing to the DOM the boot watchdog could count as progress. Under
 * reduced motion the kite stands still and the screen says "Updating Kite…".
 */
export function ReloadReturnScene() {
	return (
		<div data-reload-return aria-hidden="true" className="reload-return pointer-events-none absolute inset-0">
			<div className="reload-return-cloud reload-return-cloud-1" />
			<div className="reload-return-cloud reload-return-cloud-2" />
			<div className="reload-return-wind reload-return-wind-1" />
			<div className="reload-return-wind reload-return-wind-2" />
			<div className="reload-return-wind reload-return-wind-3" />
			<div className="reload-return-arrive">
				<div className="reload-return-swing">
					<svg className="reload-return-kite" viewBox="-30 0 150 230" fill="none">
						{/* The string runs from the bridle point down to the hand holding it, just above the progress bar. */}
						<path
							className="reload-return-string"
							d="M47 46 C 50 100, 52 160, 45 230"
							stroke="currentColor"
							strokeWidth="1.4"
							strokeLinecap="round"
						/>
						<KiteGlyph fillId="reload-return-fill" tailClassName="reload-return-tail" />
					</svg>
				</div>
			</div>
		</div>
	);
}
