"use client";

import { AdminBackupHealthCard } from "@/components/admin-backup-health-card";
import { AdminDatabaseSizeCard } from "@/components/admin-database-size-card";
import { AdminPendingMigrationsNotice, AdminUpdateCard } from "@/components/admin-update-card";
import { useCurrentUser } from "@/hooks/use-current-user";

export default function AdminSettingsPage() {
	const user = useCurrentUser();

	return (
		<div>
			<div className="mb-8">
				<h1 className="text-xl font-semibold tracking-tight text-neutral-900">Admin settings</h1>
				<p className="mt-1 text-sm text-neutral-500">Manage workspace-level mail infrastructure and integrations.</p>
			</div>
			{user?.isPrimaryAdmin ? (
				<div className="space-y-6">
					{/* First, so pending database updates are the first thing the primary admin sees. */}
					<AdminUpdateCard />
					<AdminDatabaseSizeCard />
					<AdminBackupHealthCard />
				</div>
			) : (
				user?.role === "admin" && <AdminPendingMigrationsNotice />
			)}
		</div>
	);
}
