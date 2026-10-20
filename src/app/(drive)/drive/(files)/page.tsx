import { Suspense } from "react";
import { DriveBrowser } from "@/components/drive/drive-browser";

export default function MyDrivePage() {
	return (
		<Suspense>
			<DriveBrowser view="my" />
		</Suspense>
	);
}
