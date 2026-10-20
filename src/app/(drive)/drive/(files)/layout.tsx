import type { ReactNode } from "react";
import { DashboardSectionShell } from "@/components/dashboard-section-shell";
import { DriveNav } from "@/components/drive/drive-nav";

export default function DriveFilesLayout({ children }: { children: ReactNode }) {
	return <DashboardSectionShell nav={<DriveNav />}>{children}</DashboardSectionShell>;
}
