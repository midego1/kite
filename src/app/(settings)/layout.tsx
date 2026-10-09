import { DashboardSectionShell } from "@/components/dashboard-section-shell";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
	return <DashboardSectionShell>{children}</DashboardSectionShell>;
}
