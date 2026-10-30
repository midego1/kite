"use client";

import { AdminBackupHealthCard } from "@/components/admin-backup-health-card";
import { AdminDatabaseSizeCard } from "@/components/admin-database-size-card";
import { AdminPendingMigrationsNotice, AdminUpdateCard } from "@/components/admin-update-card";
import { PageHeader } from "@/components/ui/page";
import { AdminDirectUploadsReminder } from "@/components/storage/direct-uploads-reminder";
import { useCurrentUser } from "@/hooks/use-current-user";

export default function AdminSettingsPage() {
	const user = useCurrentUser();

	return (
		<div>
			<PageHeader
				title="Overview"
				description="The state of this install: database updates, size and backups."
				className="mb-8"
			/>
			{user?.isPrimaryAdmin ? (
				<div className="space-y-6">
					{/* First, so pending database updates are the first thing the primary admin sees. */}
					<AdminUpdateCard />
					<AdminDirectUploadsReminder />
					<AdminDatabaseSizeCard />
					<AdminBackupHealthCard />
				</div>
			) : (
				user?.role === "admin" && <AdminPendingMigrationsNotice />
			)}
		</div>
	);
}
