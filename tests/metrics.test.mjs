import assert from "node:assert/strict";
import test from "node:test";
import { createNoopMetrics, recordMetric, safeLabel, statusClass } from "../src/lib/metrics.mjs";

function fake() {
	const points = [];
	return { points, writeDataPoint: (point) => points.push(point) };
}

const base = {
	event: "http",
	service: "kite",
	name: "/api/messages",
	outcome: "ok",
	statusClass: "2xx",
	detail: "GET",
};

test("recordMetric writes the fixed layout", () => {
	const dataset = fake();
	recordMetric(dataset, { ...base, version: "", durationMs: 12, status: 200, attempts: 0 });
	assert.deepEqual(dataset.points, [
		{
			indexes: ["http"],
			blobs: ["http", "kite", "/api/messages", "ok", "2xx", "GET", ""],
			doubles: [12, 200, 0, 1],
		},
	]);
});

test("missing fields default to empty labels and zero numbers", () => {
	const dataset = fake();
	recordMetric(dataset, { event: "send", service: "node", durationMs: Number.NaN });
	assert.deepEqual(dataset.points[0].blobs, ["send", "node", "", "", "", "", ""]);
	assert.deepEqual(dataset.points[0].doubles, [0, 0, 0, 1]);
});

test("unsafe labels become other", () => {
	const dataset = fake();
	for (const value of ["alice@example.com", "x".repeat(65), "a b", "x?y=1", 5])
		recordMetric(dataset, { ...base, detail: value });
	assert.deepEqual(
		dataset.points.map((point) => point.blobs[5]),
		["other", "other", "other", "other", "other"],
	);
	assert.equal(safeLabel("x".repeat(64)), "x".repeat(64));
	assert.equal(safeLabel("/api/v1/domains/[id]"), "/api/v1/domains/[id]");
	assert.equal(safeLabel(undefined), "");
});

test("recordMetric never throws", () => {
	assert.doesNotThrow(() => recordMetric(undefined, base));
	assert.doesNotThrow(() => recordMetric(null, base));
	assert.doesNotThrow(() =>
		recordMetric(
			{
				writeDataPoint() {
					throw new Error("boom");
				},
			},
			base,
		),
	);
	assert.doesNotThrow(() => createNoopMetrics().writeDataPoint({}));
});

test("statusClass groups statuses", () => {
	assert.equal(statusClass(200), "2xx");
	assert.equal(statusClass(404), "4xx");
	assert.equal(statusClass(503), "5xx");
	assert.equal(statusClass(0), "");
	assert.equal(statusClass(101), "");
	assert.equal(statusClass(Number.NaN), "");
});

test("the no-op dataset accepts points and records nothing", () => {
	const dataset = createNoopMetrics();
	assert.equal(dataset.writeDataPoint({ indexes: ["send"] }), undefined);
	recordMetric(dataset, { event: "send", service: "node" });
});
