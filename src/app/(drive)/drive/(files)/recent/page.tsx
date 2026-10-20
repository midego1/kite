import { Suspense } from "react";
import { DriveBrowser } from "@/components/drive/drive-browser";

export default function RecentFilesPage() {
	return (
		<Suspense>
			<DriveBrowser view="recent" />
		</Suspense>
	);
}
