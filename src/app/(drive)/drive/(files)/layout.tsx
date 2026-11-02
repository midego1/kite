import type { ReactNode } from "react";
import { DashboardSectionShell } from "@/components/dashboard-section-shell";
import { DrivePanels } from "@/components/drive/drive-nav";

/** The listing pages in the app frame: the mail menu in the sidebar, the Drive views beside the list. */
export default function DriveFilesLayout({ children }: { children: ReactNode }) {
	return (
		<DashboardSectionShell>
			<DrivePanels>{children}</DrivePanels>
		</DashboardSectionShell>
	);
}
