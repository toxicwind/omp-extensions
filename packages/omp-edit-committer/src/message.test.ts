/**
 * Tests for the commit message builder.
 *
 * The builder is the part of the extension that produces the *content* of
 * every auto-commit. It's pure (no I/O, no git), which makes it the
 * cheapest invariant to test. The other components are exercised
 * implicitly by the extension smoke test.
 */
import { describe, expect, test } from "bun:test";
import type {
	EditToolDetails,
	EditToolPerFileResult,
} from "@oh-my-pi/pi-coding-agent";
import {
	type DiffSummary,
	buildMessage,
	buildSubject,
	fillHunkSha,
	summarize,
} from "./message.ts";

const SINGLE_EDIT_DIFF = [
	"@@ -12,7 +12,9 @@",
	" function foo() {",
	"-	return old_helper(x);",
	"+	const y = new_helper(x);",
	"+	if (!y.ok) throw new Error('nope');",
	"+	return y.value;",
	" }",
	"",
].join("\n");

function singleFileDetails(
	diff = SINGLE_EDIT_DIFF,
	path = "src/lib/foo.ts",
): EditToolDetails {
	return {
		diff,
		path,
		firstChangedLine: 13,
	};
}

function perFile(
	overrides: Partial<EditToolPerFileResult> = {},
): EditToolPerFileResult[] {
	return [
		{
			path: "src/lib/foo.ts",
			diff: SINGLE_EDIT_DIFF,
			firstChangedLine: 13,
			...overrides,
		},
	];
}

describe("summarize", () => {
	test("counts added / removed / hunks from a unified diff", () => {
		const summary = summarize(
			["src/lib/foo.ts"],
			singleFileDetails(),
			undefined,
		);
		expect(summary.added).toBe(3);
		expect(summary.removed).toBe(1);
		expect(summary.hunks).toBe(1);
		expect(summary.paths).toEqual(["src/lib/foo.ts"]);
		expect(summary.firstAddedLine).toBe("const y = new_helper(x);");
		expect(summary.firstRemovedLine).toBe("return old_helper(x);");
		expect(summary.hasMultiFile).toBe(false);
		expect(summary.hasManyHunks).toBe(false);
	});

	test("de-duplicates repeated paths", () => {
		const summary = summarize(
			["src/lib/foo.ts", "src/lib/foo.ts", "src/lib/bar.ts"],
			undefined,
			perFile(),
		);
		expect(summary.paths).toEqual(["src/lib/foo.ts", "src/lib/bar.ts"]);
		expect(summary.hasMultiFile).toBe(true);
	});

	test("flags structural changes from perFile op", () => {
		const summary = summarize(["new.ts"], undefined, [
			{ path: "new.ts", diff: "@@ -0,0 +1,1 @@\n+hi\n", op: "create" },
		]);
		expect(summary.hasStructuralChange).toBe(true);
	});

	test("counts many hunks", () => {
		const diff = Array.from(
			{ length: 5 },
			(_, i) => `@@ -${i + 1} +${i + 1} @@`,
		).join("\n");
		const summary = summarize(["x.ts"], { diff, path: "x.ts" }, undefined);
		expect(summary.hunks).toBe(5);
		expect(summary.hasManyHunks).toBe(true);
	});
});

describe("buildSubject", () => {
	test("uses file stem as scope and verb from the first added line", () => {
		const summary = summarize(
			["src/lib/foo.ts"],
			singleFileDetails(),
			undefined,
		);
		const subject = buildSubject(summary, "edit");
		expect(subject).toMatch(/^edit\(foo\):/);
	});

	test("picks the rename kind regardless of hint", () => {
		const summary = summarize(["src/x.ts"], singleFileDetails(), undefined);
		const subject = buildSubject(summary, "rename");
		expect(subject.startsWith("rename(x):")).toBe(true);
	});

	test("truncates to 72 characters", () => {
		const long = "x".repeat(200);
		const summary: DiffSummary = {
			paths: ["src/foo.ts"],
			added: 1,
			removed: 0,
			hunks: 1,
			hasStructuralChange: false,
			hasMultiFile: false,
			hasManyHunks: false,
			firstAddedLine: long,
			firstRemovedLine: null,
		};
		const subject = buildSubject(summary, "edit");
		expect(subject.length).toBeLessThanOrEqual(72);
		expect(subject.endsWith("...")).toBe(true);
	});
});

describe("buildMessage", () => {
	test("emits every section for a complex multi-file edit", () => {
		const summary = summarize(["src/a.ts", "src/b.ts"], undefined, [
			{ path: "src/a.ts", diff: SINGLE_EDIT_DIFF, op: undefined },
			{ path: "src/b.ts", diff: SINGLE_EDIT_DIFF, op: undefined },
		]);
		const out = buildMessage(summary, {
			kind: "edit",
			intentHint: "swap helper to the new failure-aware variant",
		});
		expect(out.body).toContain("Intent");
		expect(out.body).toContain(
			"- swap helper to the new failure-aware variant",
		);
		expect(out.body).toContain("Trade-offs");
		expect(out.body).toContain("spans multiple files");
		expect(out.body).toContain("Diagram");
		expect(out.body).toContain("```");
		expect(out.body).toContain("Refs: src/a.ts, src/b.ts, +");
		expect(out.body).toMatch(/^hunk:\s*$/m);
	});

	test("includes a tradeoff even for a trivial edit", () => {
		const summary = summarize(["src/a.ts"], singleFileDetails(), undefined);
		const out = buildMessage(summary, { kind: "edit" });
		expect(out.body).toContain("Trade-offs");
		// The "kept the diff shape minimal" fallback must always appear.
		expect(out.body).toMatch(/kept the diff shape minimal|no semantic change/);
	});

	test("emits a 'net removal' tradeoff when only removals exist", () => {
		const diff = "@@ -1,2 +0,0 @@\n-bye\n-bye2\n";
		const summary = summarize(
			["src/gone.ts"],
			{ diff, path: "src/gone.ts" },
			undefined,
		);
		const out = buildMessage(summary, { kind: "delete" });
		expect(out.body).toContain("the file is gone");
	});
});

describe("fillHunkSha", () => {
	test("substitutes the SHA on the hunk: footer", () => {
		const out = fillHunkSha("subject\n\nhunk: \n", "abc1234");
		expect(out).toBe("subject\n\nhunk: abc1234\n");
	});

	test("leaves existing SHA untouched", () => {
		const out = fillHunkSha("subject\n\nhunk: deadbeef\n", "abc1234");
		expect(out).toBe("subject\n\nhunk: deadbeef\n");
	});
});
