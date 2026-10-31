import { DemoChat, DemoPanel } from "./home-demo-panels";
import { DemoList, DemoSidebar, DemoToast } from "./home-demo-parts";
import { DemoComposer, DemoReader } from "./home-demo-reader";
import { isPanelView } from "./home-demo-state-utils";
import type { DemoFrameProps } from "./home-demo-types";

/**
 * The whole demo frame for one state. The server renders it once with the opening state and no handlers, so
 * the hero paints without JavaScript; the client demo (home-demo.tsx) renders the same frame with its state
 * and one delegated click handler. Both produce the same markup.
 */
export function DemoFrame(props: DemoFrameProps) {
	const { state, live, appName, onClick, onKeyDown } = props;
	const panel = isPanelView(state.view);
	return (
		<div
			role="region"
			aria-label={`Live demo of the ${appName} inbox with invented data. Open messages and folders, archive, approve or reply; nothing leaves this page.`}
			data-testid="home-product-mock"
			data-demo={live ? "ready" : "static"}
			onClick={onClick}
			onKeyDown={onKeyDown}
			className="relative mx-auto h-[600px] w-full max-w-6xl overflow-hidden rounded-2xl border border-neutral-200 bg-white text-left shadow-[0_30px_80px_-40px_rgba(79,70,229,0.45)] md:h-[700px]"
		>
			<div className="grid h-full grid-cols-1 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:grid-cols-[200px_minmax(0,0.9fr)_minmax(0,1.1fr)]">
				<DemoSidebar {...props} />
				{panel ? (
					<DemoPanel {...props} />
				) : (
					<>
						<DemoList {...props} />
						<DemoReader {...props} />
					</>
				)}
			</div>
			{state.menuOpen && (
				<button
					type="button"
					data-action="toggleMenu"
					aria-label="Close menu"
					className="absolute inset-0 z-10 bg-black/30 lg:hidden"
				/>
			)}
			<DemoToast {...props} />
			<DemoComposer {...props} />
			<DemoChat {...props} />
		</div>
	);
}
