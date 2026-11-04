function seconds(ms) {
	return `${(ms / 1000).toFixed(1)}s`;
}

export function collectPlaywrightTests(report) {
	const found = [];
	const walk = (suite, file) => {
		const suiteFile = suite.file ?? file;
		for (const spec of suite.specs ?? []) {
			for (const test of spec.tests ?? []) {
				found.push({ file: spec.file ?? suiteFile ?? "", title: spec.title, status: test.status });
			}
		}
		for (const child of suite.suites ?? []) walk(child, suiteFile);
	};
	for (const suite of report.suites ?? []) walk(suite);
	return found;
}

export function renderTimings(timings) {
	if (!timings) return "_Task timings: not run._";
	const rows = (timings.tasks ?? []).map((entry) => {
		if (entry.skipped) return `| ${entry.task} | skipped | ${entry.reason ?? ""} |`;
		return `| ${entry.task} | ${seconds(entry.durationMs)} | ${entry.exitCode === 0 ? "0" : `**${entry.exitCode}**`} |`;
	});
	const total = (timings.tasks ?? []).reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0);
	return [
		"### Task timings",
		"",
		"| Task | Duration | Exit code |",
		"| --- | --- | --- |",
		...rows,
		"",
		`Total: ${seconds(total)}`,
	].join("\n");
}

export function renderPlaywright(report, heading = "Playwright") {
	if (!report) return `_${heading}: not run._`;
	const stats = report.stats ?? {};
	const flaky = collectPlaywrightTests(report).filter((test) => test.status === "flaky");
	const lines = [
		`### ${heading}`,
		"",
		`Passed ${stats.expected ?? 0}, failed ${stats.unexpected ?? 0}, flaky ${stats.flaky ?? 0}, skipped ${stats.skipped ?? 0}`,
	];
	if (flaky.length) {
		lines.push("", "Flaky tests (passed on retry):", ...flaky.map((test) => `- \`${test.file}\`: ${test.title}`));
	}
	return lines.join("\n");
}

export function renderCoverage(summary) {
	const aggregate = summary?.aggregate;
	if (!aggregate) return "_Coverage: not run._";
	const row = (name) => `| ${name} | ${aggregate[name]}% | ${aggregate.thresholds?.[name] ?? ""}% |`;
	return [
		"### Coverage",
		"",
		"| Metric | Measured | Gate |",
		"| --- | --- | --- |",
		row("lines"),
		row("branches"),
		row("functions"),
		"",
		aggregate.passed ? "Gate passed." : `**Gate failed:** ${(aggregate.failures ?? []).join("; ")}`,
	].join("\n");
}

/** `slices` holds the results of slices run side by side (scripts/quality/e2e-pair.mjs), each under its own heading. */
export function renderSummary({ timings, playwright, slices = [], coverage }) {
	const browser = slices.map(({ slice, report }) => renderPlaywright(report, `Playwright (slice ${slice})`));
	if (playwright || !slices.length) browser.unshift(renderPlaywright(playwright));
	return `## CI summary\n\n${[renderTimings(timings), ...browser, renderCoverage(coverage)].join("\n\n")}\n`;
}
