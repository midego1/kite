import { UPSTREAM_URL } from "./utils";
import { PERFORMANCE_URL, compareColumns, compareRows, upstreamRows } from "./home-content";
import { HomeTable } from "./home-table";
import { HomeSection, textLink } from "./home-ui";
import type { HomeSectionProps } from "./types";

/** Kite, Mailflare, Email Routing and a hosted inbox. The honest cells stay, including where Kite is behind. */
export function HomeCompare({ appName }: HomeSectionProps) {
	return (
		<HomeSection
			id="compare"
			headingId="home-compare-heading"
			title="When Kite fits, and when it doesn't"
			stacked
			intro={
				<>
					Choose Email Routing alone if forwarding is enough, a hosted inbox if you want polish and someone on call, and{" "}
					<a href={UPSTREAM_URL} target="_blank" rel="noopener noreferrer" className={textLink}>
						Mailflare
					</a>{" "}
					if you want the upstream project.
				</>
			}
		>
			<HomeTable
				label="Comparison of Kite, Mailflare, Email Routing and hosted inboxes"
				from="lg"
				columns={compareColumns.map((column, index) => ({
					label: index === 0 ? appName : column,
					ink: index === 0,
				}))}
				rows={compareRows.map((row) => ({ key: row.label, head: row.label, cells: row.cells }))}
				rowHeadClassName="text-sm font-normal text-(--home-dim)"
			/>
			<HomeUpstream />
		</HomeSection>
	);
}

/** README performance rows only. Before is the earlier result; Now is this version, set larger because it is the point. */
function HomeUpstream() {
	return (
		<div className="mt-20 grid gap-x-10 gap-y-8 border-t border-(--home-line) pt-12 lg:grid-cols-12">
			<div className="lg:col-span-4">
				<h3 id="home-upstream-heading" className="text-2xl font-medium tracking-[-0.02em]">
					Before and now
				</h3>
				<p className="mt-3 max-w-sm text-pretty text-[15px] leading-7 text-(--home-mute)">
					Measured on a production build in a plain Chrome profile.{" "}
					<a href={PERFORMANCE_URL} target="_blank" rel="noopener noreferrer" className={textLink}>
						Performance in the README
					</a>
					.
				</p>
			</div>
			<div className="min-w-0 lg:col-span-8">
				<HomeTable
					label="Before and now"
					from="md"
					columns={[{ label: "Before" }, { label: "Now", ink: true, big: true }]}
					rows={upstreamRows.map((row) => ({ key: row.label, head: row.label, cells: [row.before, row.now] }))}
					rowHeadClassName="w-1/3 text-base font-medium"
				/>
			</div>
		</div>
	);
}
