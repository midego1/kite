"use client";

import { AdminBackupHealthCard } from "@/components/admin-backup-health-card";
import { AdminDatabaseSizeCard } from "@/components/admin-database-size-card";
import { AdminPendingMigrationsNotice, AdminUpdateCard } from "@/components/admin-update-card";
import { PageHeader } from "@/components/ui/page";
import { Skeleton } from "@/components/ui/skeleton";
import { StatGrid, StatTile } from "@/components/ui/stat-tile";
import { dismissDirectUploadsReminder, STORAGE_OVERVIEW_KEY } from "@/components/storage/direct-uploads-reminder";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useQueryClient } from "@tanstack/react-query";
import { AttentionList } from "./attention-list";
import { attentionItems, overviewStats } from "./overview-utils";
import { useOverview } from "./use-overview";

/** A card the attention list jumps to; focusable, so the jump moves the keyboard and screen reader there too. */
function Anchor({ id, children }: { id: string; children: React.ReactNode }) {
	return (
		<div
			id={id}
			tabIndex={-1}
			className="scroll-mt-6 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
		>
			{children}
		</div>
	);
}

export default function AdminOverviewPage() {
	const user = useCurrentUser();
	const primary = user?.isPrimaryAdmin === true;
	// Accounts and mailboxes for every admin, domains with the grant, the database for the primary admin.
	const expectedTiles = 2 + (primary || user?.canManageDomains ? 1 : 0) + (primary ? 1 : 0);
	const { data, loading } = useOverview(primary, user?.role === "admin");
	const stats = overviewStats(data);
	const queryClient = useQueryClient();
	// Only the direct-uploads reminder is dismissible; it hides on the Storage page too.
	const dismiss = (id: string) => {
		if (id !== "direct-uploads") return;
		void dismissDirectUploadsReminder().then(() => queryClient.invalidateQueries({ queryKey: STORAGE_OVERVIEW_KEY }));
	};

	return (
		<div className="space-y-8">
			<PageHeader title="Overview" description="What needs attention, the numbers, and the database." />
			<AttentionList items={loading ? [] : attentionItems(data, primary)} loading={loading} onDismiss={dismiss} />
			{!primary && <AdminPendingMigrationsNotice />}
			<section aria-label="At a glance">
				{loading ? (
					<StatGrid>
						{Array.from({ length: expectedTiles }, (_, index) => (
							<Skeleton key={index} className="h-24 rounded-xl" />
						))}
					</StatGrid>
				) : (
					<StatGrid>
						{stats.map((stat) => (
							<StatTile
								key={stat.id}
								label={stat.label}
								value={stat.value}
								hint={stat.hint}
								href={stat.href}
								tone={stat.tone}
								data-testid={`stat-${stat.id}`}
							/>
						))}
					</StatGrid>
				)}
			</section>
			{primary && (
				<div className="space-y-6">
					<Anchor id="database">
						<AdminUpdateCard />
					</Anchor>
					<Anchor id="database-size">
						<AdminDatabaseSizeCard />
					</Anchor>
					<Anchor id="backups">
						<AdminBackupHealthCard />
					</Anchor>
				</div>
			)}
		</div>
	);
}
