import { DemoFrame } from "./home-demo-frame";
import { HomeDemoHost } from "./home-demo-host";
import { createDemoState } from "./home-demo-state-utils";
import type { HomeDemoProps } from "./home-demo-types";

/**
 * The product preview in the hero: a live demo of the inbox on invented data (home-demo-data.ts). The frame
 * is rendered on the server in its opening state, so the hero paints without JavaScript, and the host swaps
 * in the interactive version (home-demo.tsx) once its chunk has loaded.
 */
export function HomeProductMock({ appName }: HomeDemoProps) {
	return (
		<HomeDemoHost appName={appName}>
			<DemoFrame state={createDemoState()} live={false} appName={appName} />
		</HomeDemoHost>
	);
}
