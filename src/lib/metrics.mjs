/**
 * Workers Analytics Engine data points. Portable (no imports) so the relay Worker can use it.
 *
 * Fixed layout, so queries can rely on column positions:
 *   indexes: [event]
 *   blobs:   [event, service, name, outcome, statusClass, detail, version]  (blob1..blob7)
 *   doubles: [durationMs, status, attempts, 1]                              (double1..double4)
 * event: http | queue | send | webhook | relay | inbound
 * service: kite | kite-email-relay | node
 *
 * Labels carry low-cardinality categories only: never addresses, ids, URLs, paths or error text.
 * @typedef {{ writeDataPoint(point: { indexes?: string[], blobs?: string[], doubles?: number[] }): void }} MetricsDataset
 */

const SAFE_LABEL = /^[A-Za-z0-9_.:/[\]{}-]*$/;

/** @returns {MetricsDataset} */
export function createNoopMetrics() {
	return { writeDataPoint() {} };
}

/** @param {unknown} value */
export function safeLabel(value) {
	if (value === undefined || value === null) return "";
	if (typeof value !== "string" || value.length > 64 || !SAFE_LABEL.test(value)) return "other";
	return value;
}

/** @param {number} status */
export function statusClass(status) {
	return Number.isInteger(status) && status >= 200 && status < 600 ? `${Math.floor(status / 100)}xx` : "";
}

const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * Never throws; a missing binding is a no-op.
 * @param {MetricsDataset | null | undefined} dataset
 * @param {{ event: string, service: string, name?: string, outcome?: string, statusClass?: string, detail?: string, version?: string, durationMs?: number, status?: number, attempts?: number }} fields
 */
export function recordMetric(dataset, fields) {
	try {
		if (!dataset) return;
		const { event, service, name, outcome, statusClass: statusLabel, detail, version } = fields;
		dataset.writeDataPoint({
			indexes: [safeLabel(event)],
			blobs: [event, service, name, outcome, statusLabel, detail, version].map(safeLabel),
			doubles: [finite(fields.durationMs), finite(fields.status), finite(fields.attempts), 1],
		});
	} catch {
		// Metrics must never affect the request they describe.
	}
}
