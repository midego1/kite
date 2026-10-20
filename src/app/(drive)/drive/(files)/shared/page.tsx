import { Suspense } from "react";
import { DriveBrowser } from "@/components/drive/drive-browser";

export default function SharedWithMePage() {
	return (
		<Suspense>
			<DriveBrowser view="shared" />
		</Suspense>
	);
}
