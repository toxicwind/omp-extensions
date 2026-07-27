/**
 * Smoke test: drive the extension end-to-end against a real git repo.
 *
 * We can't load the real `omp` runtime here (it owns the TUI / session
 * machinery), so we exercise the same code paths by:
 *
 *   1. Building a temp git repo with a user identity.
 *   2. Loading the helper modules directly.
 *   3. Running `commitPaths` with a synthesized commit message.
 *   4. Asserting the commit landed, the SHA is captured, and the message
 *      contains the expected sections.
 *
 * Run with: `bun test`
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commitPaths, probeRepo, statStagedPaths } from "../src/git.ts";
import { type EditKind, buildMessage, summarize } from "../src/message.ts";

const DIFF = [
	"@@ -12,7 +12,9 @@",
	" function foo() {",
	"-	return old_helper(x);",
	"+	const y = new_helper(x);",
	"+	if (!y.ok) throw new Error('nope');",
	"+	return y.value;",
	" }",
	"",
].join("\n");

interface Harness {
	cwd: string;
	toplevel: string;
	cleanup: () => void;
}

function run(
	cwd: string,
	args: string[],
): { code: number; stdout: string; stderr: string } {
	const proc = Bun.spawnSync(["git", ...args], {
		cwd,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	return {
		code: proc.exitCode ?? 1,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

async function makeHarness(): Promise<Harness> {
	const dir = mkdtempSync(join(tmpdir(), "omp-edit-committer-smoke-"));
	const init = run(dir, ["init", "-q", "-b", "main"]);
	if (init.code !== 0) throw new Error(`git init failed: ${init.stderr}`);
	const user = run(dir, ["config", "user.name", "Smoke Test"]);
	if (user.code !== 0)
		throw new Error(`git config user.name failed: ${user.stderr}`);
	const email = run(dir, ["config", "user.email", "smoke@example.com"]);
	if (email.code !== 0)
		throw new Error(`git config user.email failed: ${email.stderr}`);
	const top = run(dir, ["rev-parse", "--show-toplevel"]);
	if (top.code !== 0) throw new Error(`git rev-parse failed: ${top.stderr}`);
	return {
		cwd: dir,
		toplevel: top.stdout.trim(),
		cleanup: () => {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// Best effort; tmpdir gets reaped eventually.
			}
		},
	};
}

describe("git + message end-to-end", () => {
	let harness: Harness | null = null;
	const useHarness = (): Harness => {
		if (!harness) throw new Error("harness missing — beforeEach did not run");
		return harness;
	};

	beforeEach(async () => {
		harness = await makeHarness();
	});
	afterEach(() => {
		harness?.cleanup();
		harness = null;
	});

	test("probeRepo returns insideRepo=true on a fresh repo", async () => {
		const h = useHarness();
		const probe = await probeRepo(h.cwd);
		expect(probe.insideRepo).toBe(true);
		expect(probe.identityConfigured).toBe(true);
		expect(probe.toplevel).toBe(h.toplevel);
	});

	test("commitPaths creates a real commit with the expected message", async () => {
		const h = useHarness();
		const target = join(h.cwd, "src", "lib", "foo.ts");
		mkdirSync(join(h.cwd, "src", "lib"), { recursive: true });
		writeFileSync(
			target,
			"export function foo() {\n\treturn old_helper(x);\n}\n",
		);
		run(h.cwd, ["add", "."]);
		run(h.cwd, ["commit", "-m", "initial", "--no-verify", "--no-gpg-sign"]);

		// Simulate the agent editing the file: write the new content, then
		// run the committer with the synthesized summary.
		writeFileSync(
			target,
			"export function foo() {\n" +
				"\tconst y = new_helper(x);\n" +
				"\tif (!y.ok) throw new Error('nope');\n" +
				"\treturn y.value;\n" +
				"}\n",
		);

		const summary = summarize(
			["src/lib/foo.ts"],
			{ diff: DIFF, path: "src/lib/foo.ts" },
			undefined,
		);
		const message = buildMessage(summary, {
			kind: "edit" as EditKind,
			intentHint: "swap to failure-aware helper",
		});
		const result = await commitPaths(h.cwd, ["src/lib/foo.ts"], message.body);
		expect(result.sha).not.toBeNull();
		if (!result.sha) throw new Error("commit did not return a SHA");
		expect(result.skipped).toBe(false);

		// Verify the commit landed with the right message. We grep the log
		// rather than compare exact text so the test stays decoupled from
		// future wording tweaks.
		const log = run(h.cwd, ["log", "-1", "--format=%H%n%s%n--BODY--%n%b"]);
		expect(log.code).toBe(0);
		const [sha, subject, ...rest] = log.stdout.split("\n");
		const body = rest.join("\n");
		// `rev-parse --short` is at most 7 chars, so compare against the
		// matching prefix of the full SHA recorded in the log.
		expect(sha?.startsWith(result.sha)).toBe(true);
		expect(subject).toContain("swap to failure-aware helper");
		expect(body).toContain("Intent");
		expect(body).toContain("Trade-offs");
		expect(body).toContain("Refs: src/lib/foo.ts");
		// The body advertises a `hunk: yes` marker, not the SHA. The live
		// SHA lives in the TUI badge; see message.ts for why we don't try
		// to embed it in the body.
		expect(body).toMatch(/^hunk: yes$/m);
	});

	test("commitPaths is a no-op when the index has no changes", async () => {
		const h = useHarness();
		const target = join(h.cwd, "empty.ts");
		writeFileSync(target, "noop\n");
		run(h.cwd, ["add", "empty.ts"]);
		run(h.cwd, ["commit", "-m", "seed", "--no-verify", "--no-gpg-sign"]);
		// Don't modify the file; the committer should refuse an empty commit.
		const result = await commitPaths(h.cwd, ["empty.ts"], "should not land");
		expect(result.sha).toBeNull();
		expect(result.skipped).toBe(true);
		expect(result.reason).toBe("nothing to commit");
	});

	test("commitPaths leaves the user's pre-existing staged work alone", async () => {
		// Regression test: a plain `git commit` would sweep any unrelated
		// staged changes into our auto-commit. `git commit --only -- <paths>`
		// must not.
		const h = useHarness();
		const target = join(h.cwd, "edit-me.ts");
		const staged = join(h.cwd, "user-staged.ts");
		writeFileSync(target, "v1\n");
		writeFileSync(staged, "user work\n");
		run(h.cwd, ["add", "."]);
		run(h.cwd, ["commit", "-m", "initial", "--no-verify", "--no-gpg-sign"]);
		// User stages an unrelated file and DOESN'T commit it.
		writeFileSync(staged, "user work v2\n");
		run(h.cwd, ["add", "user-staged.ts"]);
		// Agent edits the target file.
		writeFileSync(target, "v2\n");
		const result = await commitPaths(h.cwd, [target], "edit(edit-me): bump\n");
		expect(result.sha).not.toBeNull();
		// The user's staged work must still be in the index after our commit.
		const diff = run(h.cwd, ["diff", "--cached", "--name-only"]);
		expect(diff.stdout.trim()).toBe("user-staged.ts");
		// And the auto-commit must only have changed `edit-me.ts`.
		const show = run(h.cwd, ["show", "--name-only", "--format=", "HEAD"]);
		expect(show.stdout.trim()).toBe("edit-me.ts");
	});

	test("commitPaths records the deletion half of a rename", async () => {
		// Regression test: a pure rename has 0/0 in the numstat and
		// shows up in the diff text as `rename from / rename to`
		// instead of `+` / `-` lines. The committer must (a) include
		// both the source and destination in the pathspec and
		// (b) not skip the commit on the 0/0 stat.
		const h = useHarness();
		const source = join(h.cwd, "old-name.ts");
		const dest = join(h.cwd, "new-name.ts");
		writeFileSync(source, "export const x = 1;\n");
		run(h.cwd, ["add", "old-name.ts"]);
		run(h.cwd, ["commit", "-m", "seed", "--no-verify", "--no-gpg-sign"]);
		// Move the file: rename on disk.
		run(h.cwd, ["mv", "old-name.ts", "new-name.ts"]);

		const stat = await statStagedPaths(h.cwd, [source, dest]);
		expect(stat.hasRename).toBe(true);
		expect(stat.added).toBe(0);
		expect(stat.removed).toBe(0);

		const result = await commitPaths(
			h.cwd,
			[source, dest],
			"rename(old-name): new-name\n",
		);
		expect(result.sha).not.toBeNull();
		expect(result.skipped).toBe(false);

		// The commit must show the rename (R), not just the new file (A).
		const show = run(h.cwd, ["show", "--name-status", "--format=", "HEAD"]);
		const status = show.stdout.trim().split("\t")[0];
		expect(status).toMatch(/^R/);
		expect(show.stdout).toContain("old-name.ts");
		expect(show.stdout).toContain("new-name.ts");
		// And the worktree must not still have the old name.
		const ls = run(h.cwd, ["ls-files"]);
		expect(ls.stdout).toContain("new-name.ts");
		expect(ls.stdout).not.toContain("old-name.ts");
	});
});
