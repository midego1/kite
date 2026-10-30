"use client";

import { AdminBackupHealthCard } from "@/components/admin-backup-health-card";
import { AdminDatabaseSizeCard } from "@/components/admin-database-size-card";
import { AdminUpdateCard } from "@/components/admin-update-card";
import { PageHeader } from "@/components/ui/page";
import { Skeleton } from "@/components/ui/skeleton";
import { StatGrid, StatTile } from "@/components/ui/stat-tile";
import { useCurrentUser } from "@/hooks/use-current-user";
import { BUILD_VERSION } from "@/lib/build-version";
import { AttentionList } from "./attention-list";
import { attentionItems, overviewStats } from "./overview-utils";
import { useOverview } from "./use-overview";

export default function AdminOverviewPage() {
	const user = useCurrentUser();
	const primary = user?.isPrimaryAdmin === true;
	const overview = useOverview(primary, user?.role === "admin");
	const data = overview.data;
	const stats = data ? overviewStats(data, BUILD_VERSION) : [];

	return (
		<div className="space-y-8">
			<PageHeader
				title="Overview"
				description={`Kite v${BUILD_VERSION}. What needs attention, the numbers, and the database.`}
			/>
			<AttentionList items={data ? attentionItems(data, primary) : []} loading={!data} />
			<section aria-label="At a glance">
				{data ? (
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
				) : (
					<StatGrid>
						{Array.from({ length: primary ? 4 : 3 }, (_, index) => (
							<Skeleton key={index} className="h-24 rounded-xl" />
						))}
					</StatGrid>
				)}
			</section>
			{primary && (
				<div className="space-y-6">
					<div id="database" className="scroll-mt-6">
						<AdminUpdateCard />
					</div>
					<div id="database-size" className="scroll-mt-6">
						<AdminDatabaseSizeCard />
					</div>
					<div id="backups" className="scroll-mt-6">
						<AdminBackupHealthCard />
					</div>
				</div>
			)}
		</div>
	);
}
