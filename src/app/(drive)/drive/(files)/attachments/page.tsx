import { Suspense } from "react";
import { DriveBrowser } from "@/components/drive/drive-browser";

export default function AllAttachmentsPage() {
	return (
		<Suspense>
			<DriveBrowser view="attachments" />
		</Suspense>
	);
}
