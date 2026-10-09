import assert from "node:assert/strict";
import test from "node:test";
import { renderReleaseNotes } from "../scripts/release-notes.mjs";

test("groups subjects into features, fixes and maintenance", () => {
	const out = renderReleaseNotes({
		version: "1.2.3",
		base: "v1.2.2",
		subjects: ["feat(ui): a", "fix: b", "chore: c", "feat: d", "docs: e"],
	});
	assert.equal(
		out,
		"# Changes for 1.2.3\n\nCompared with v1.2.2. Review before publishing.\n\n" +
			"## Features\n\n- feat(ui): a\n- feat: d\n\n" +
			"## Fixes\n\n- fix: b\n\n" +
			"## Maintenance\n\n- chore: c\n- docs: e\n\n",
	);
});

test("omits empty sections", () => {
	const out = renderReleaseNotes({ version: "1", base: "x", subjects: ["fix(a): only"] });
	assert.ok(out.includes("## Fixes"));
	assert.ok(!out.includes("## Features"));
	assert.ok(!out.includes("## Maintenance"));
});

test("reports when there are no commits", () => {
	const out = renderReleaseNotes({ version: "1", base: "x", subjects: [] });
	assert.equal(
		out,
		"# Changes for 1\n\nCompared with x. Review before publishing.\n\nNo new commits in this comparison.\n",
	);
});

test("does not treat feature-like words as features", () => {
	const out = renderReleaseNotes({ version: "1", base: "x", subjects: ["feature flag cleanup", "fixture update"] });
	assert.ok(out.includes("## Maintenance"));
	assert.ok(!out.includes("## Features") && !out.includes("## Fixes"));
});
