import { totalCopiedRows } from "@/lib/legacy-import/copy-utils";
import type { LegacyImportRun, LegacyRoute } from "@/lib/legacy-import/types";

function tableLabel(table: string | undefined): string {
	return (table ?? "data").replaceAll("_", " ");
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function describeLegacyImportPhase(run: LegacyImportRun): string {
	switch (run.phase) {
		case "clear":
			return "Emptying this install";
		case "tables":
			return `Copying ${tableLabel(run.tables[run.tableIndex])} (${Math.min(run.tableIndex + 1, run.tables.length)} of ${run.tables.length})`;
		case "files":
			return `Copying files: ${run.files.copied.toLocaleString("en")} copied, ${run.files.skipped.toLocaleString("en")} already here`;
		default:
			return "Done";
	}
}

/** Rough share of the work done. File totals are unknown up front, so that phase only moves to 90%. */
export function legacyImportFraction(run: LegacyImportRun): number {
	if (run.phase === "done") return 1;
	if (run.phase === "clear") return 0.02;
	if (run.phase === "files") return run.files.copied + run.files.skipped > 0 ? 0.9 : 0.8;
	return 0.05 + 0.75 * (run.tables.length ? run.tableIndex / run.tables.length : 1);
}

export function summarizeLegacyImport(run: LegacyImportRun): string {
	const { written, skipped } = totalCopiedRows(run);
	const rows = `${written.toLocaleString("en")} ${written === 1 ? "row" : "rows"}`;
	const files = `${run.files.copied.toLocaleString("en")} ${run.files.copied === 1 ? "file" : "files"} (${formatBytes(run.files.bytes)})`;
	const already = skipped
		? ` ${skipped.toLocaleString("en")} ${skipped === 1 ? "row was" : "rows were"} already here.`
		: "";
	return `Copied ${rows} and ${files}.${already}`;
}

export function describeLegacyRoutes(routes: LegacyRoute[]): string {
	const catchAlls = routes.filter((route) => route.address === "*").length;
	const addresses = routes.length - catchAlls;
	const parts = [
		addresses ? `${addresses} ${addresses === 1 ? "address" : "addresses"}` : "",
		catchAlls ? `${catchAlls} ${catchAlls === 1 ? "catch-all" : "catch-alls"}` : "",
	].filter(Boolean);
	return parts.join(" and ");
}
