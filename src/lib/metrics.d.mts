export type MetricsDataset = {
	writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
};
export type MetricFields = {
	event: string;
	service: string;
	name?: string;
	outcome?: string;
	statusClass?: string;
	detail?: string;
	version?: string;
	durationMs?: number;
	status?: number;
	attempts?: number;
};
export function createNoopMetrics(): MetricsDataset;
export function safeLabel(value: unknown): string;
export function statusClass(status: number): string;
export function recordMetric(dataset: MetricsDataset | null | undefined, fields: MetricFields): void;
