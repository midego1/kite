import { existsSync, readFileSync } from "node:fs";

const TOTALS =
	/FAIL-NEW: (\d+)\s+FAIL-INPROG: (\d+)\s+WARN-NEW: (\d+)\s+WARN-INPROG: (\d+)\s+INFO: (\d+)\s+IGNORE: (\d+)\s+PASS: (\d+)/;

/** Markdown for the step summary: the baseline's own FAIL/WARN/IGNORE/PASS rule dispositions, then risk per alert. */
export function summarizeZap({ log, report }) {
	const lines = ["## ZAP baseline (report only)", ""];
	const totals = TOTALS.exec(log ?? "");
	if (totals) {
		const n = totals.slice(1).map(Number);
		lines.push("| Disposition | Rules |", "| --- | --- |");
		lines.push(`| FAIL | ${n[0] + n[1]} |`, `| WARN | ${n[2] + n[3]} |`, `| INFO | ${n[4]} |`);
		lines.push(`| IGNORE | ${n[5]} |`, `| PASS | ${n[6]} |`);
	} else {
		lines.push("ZAP printed no disposition totals; see the uploaded report.");
	}
	const alerts = (report?.site ?? []).flatMap((site) => site.alerts ?? []);
	if (alerts.length > 0) {
		lines.push("", "| Rule | Alert | Risk |", "| --- | --- | --- |");
		for (const alert of alerts) lines.push(`| ${alert.pluginid} | ${alert.alert} | ${alert.riskdesc} |`);
	}
	return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [logPath, reportPath] = process.argv.slice(2);
	const log = logPath && existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
	const report = reportPath && existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : null;
	console.log(summarizeZap({ log, report }));
}
