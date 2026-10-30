import { KiteGlyph } from "./kite-glyph";

/*
 * The startup screen's sequel to the kite's flight out (reload-flight.tsx): after a reload to a new version the
 * kite flies back in from the top right and floats on its string above the progress bar, its tail rippling, with
 * soft clouds and a few wind lines drifting by, until the app is ready and the screen fades out. Both parts are
 * server-rendered in LoadingTransition and shown only while <html> carries RELOAD_RETURN_CLASS
 * (reload-return-utils.ts), which the inline script sets before the first paint; everything moves by CSS alone
 * (`reload-return-*` in globals.css), so it runs before any chunk arrives and adds nothing to the DOM the boot
 * watchdog could count as progress. Under reduced motion the kite stands still and the screen says "Updating Kite…".
 */

/** The clouds behind everything, covering the overlay. */
export function ReloadReturnSky() {
	return (
		<div aria-hidden="true" className="reload-return-sky pointer-events-none absolute inset-0 overflow-hidden">
			<div className="reload-return-cloud reload-return-cloud-1" />
			<div className="reload-return-cloud reload-return-cloud-2" />
		</div>
	);
}

/**
 * The kite on its string and the wind, anchored to the progress bar: rendered inside the bar's wrapper, so the
 * hand holding the string stays just above the bar whatever else the column shows (the reduced-motion caption,
 * the slow-start recovery).
 */
export function ReloadReturnKite() {
	return (
		<div
			data-reload-return
			aria-hidden="true"
			className="reload-return-kite pointer-events-none absolute inset-x-0 bottom-full"
		>
			<div className="reload-return-wind reload-return-wind-1" />
			<div className="reload-return-wind reload-return-wind-2" />
			<div className="reload-return-arrive">
				<div className="reload-return-swing">
					<svg className="reload-return-glyph" viewBox="-30 0 150 230" fill="none">
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
