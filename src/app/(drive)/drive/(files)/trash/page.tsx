import { Suspense } from "react";
import { DriveBrowser } from "@/components/drive/drive-browser";

export default function DriveTrashPage() {
	return (
		<Suspense>
			<DriveBrowser view="trash" />
		</Suspense>
	);
}
