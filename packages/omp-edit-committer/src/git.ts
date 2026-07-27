/**
 * Thin wrapper around `git` for the commit-on-edit flow.
 *
 * Every entry point is fault-tolerant: if `git` is missing, the repo is not
 * a git repo, or the user disabled committing, the helper returns a typed
 * no-op result instead of throwing. The extension uses these results to
 * decide whether to surface a commit SHA badge or to silently skip.
 *
 * Uses `Bun.spawn` (declared via `@types/bun`) so the package doesn't have
 * to pull in `@types/node`. Bun's spawn is a drop-in for the parts we use.
 *
 * # Path-safety invariants
 *
 * The helper **never** commits outside the caller-supplied paths. We
 * achieve this with two complementary rules:
 *
 * 1. `git add -- <paths>` only stages the named files.
 * 2. `git commit --only -- <paths>` only includes the named files in the
 *    new tree, even if the user had other changes staged or sitting in
 *    the worktree. `--only` ignores the current index contents and
 *    refuses to include paths outside the pathspec.
 *
 * That second rule is the one the first version of this file got wrong
 * (a plain `git commit` would have swept in any unrelated staged work
 * the user happened to have at the moment of an Edit).
 *
 * # Why we don't put the SHA in the commit message
 *
 * The body advertises a `hunk:` footer so `modem-dev/hunk` reviewers
 * can spot auto-commits at a glance, but we deliberately do *not*
 * write the commit's own SHA into that footer. The chicken-and-egg:
 * a `git commit --amend` rewrites the SHA, so any SHA we wrote
 * pre-amend would point to an orphaned object. The live SHA lives
 * in the TUI badge, not in the body.
 */

/** All git subprocesses are bounded so a hung hook can't pin the agent. */
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

export interface CommitResult {
	/** Short SHA of the created commit, or null when nothing was committed. */
	sha: string | null;
	/** True when the failure is benign (no repo, no changes, not configured). */
	skipped: boolean;
	/** Human-readable reason when skipped === true or sha === null. */
	reason?: string;
	/** Raw stderr from `git commit` when the commit failed. */
	stderr?: string;
}

/** Per-path stat pulled from `git diff --cached --numstat -- <paths>`. */
export interface PathStat {
	added: number;
	removed: number;
	hunks: number;
	/** Raw diff text (empty when no changes). */
	diff: string;
	/**
	 * True when at least one path was staged as a rename / move
	 * (the diff text contains a `rename from` / `rename to` line).
	 * Renames can show up as `0/0` in the numstat — the committer
	 * must still create a commit in that case.
	 */
	hasRename: boolean;
}

/** Probe the working tree once per session to avoid spawning `git` per edit. */
export interface RepoProbe {
	insideRepo: boolean;
	toplevel: string | null;
	identityConfigured: boolean;
}

interface RunResult {
	stdout: string;
	stderr: string;
	code: number;
}

async function run(cwd: string, args: string[]): Promise<RunResult> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		timeout: GIT_TIMEOUT_MS,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		readText(proc.stdout, GIT_MAX_BUFFER),
		readText(proc.stderr, GIT_MAX_BUFFER),
		proc.exited,
	]);
	return { stdout, stderr, code: typeof code === "number" ? code : 1 };
}

async function readText(
	stream: ReadableStream<Uint8Array> | undefined,
	cap: number,
): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	let total = 0;
	const chunks: Uint8Array[] = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > cap) {
			chunks.push(
				value.subarray(0, Math.max(0, cap - (total - value.byteLength))),
			);
			break;
		}
		chunks.push(value);
	}
	reader.releaseLock();
	const merged = new Uint8Array(
		chunks.reduce((sum, c) => sum + c.byteLength, 0),
	);
	let offset = 0;
	for (const c of chunks) {
		merged.set(c, offset);
		offset += c.byteLength;
	}
	return new TextDecoder().decode(merged);
}

/**
 * Detect the git toplevel and check whether a committer identity is set.
 * Both checks are read-only and safe to run in any directory.
 */
export async function probeRepo(cwd: string): Promise<RepoProbe> {
	const top = await run(cwd, ["rev-parse", "--show-toplevel"]);
	if (top.code !== 0) {
		return { insideRepo: false, toplevel: null, identityConfigured: false };
	}
	const user = await run(cwd, ["config", "user.name"]);
	const email = await run(cwd, ["config", "user.email"]);
	const identity =
		user.code === 0 &&
		user.stdout.trim() !== "" &&
		email.code === 0 &&
		email.stdout.trim() !== "";
	return {
		insideRepo: true,
		toplevel: top.stdout.trim(),
		identityConfigured: identity,
	};
}

/**
 * Stage `paths` and return the per-path stat from `git diff --cached`.
 *
 * Callers use this to drive the commit message builder without having
 * to ship the diff through the extension's event bus — important for
 * the `write` tool, which never carries an edit-style diff in its
 * `tool_result` event.
 */
export async function statStagedPaths(
	cwd: string,
	paths: string[],
): Promise<PathStat> {
	if (paths.length === 0) {
		return { added: 0, removed: 0, hunks: 0, diff: "", hasRename: false };
	}
	// Stage each path with the right verb: `git add` for files that
	// exist on disk (creates / modifications), `git rm` for files
	// that have been deleted (the source of a rename is the common
	// case). A blanket `git add -A -- <paths>` fails on a deleted
	// source path because git can't match the pathspec against the
	// (now-gone) file; a blanket `git add -A` (no pathspec) would
	// sweep the whole worktree and break the per-edit scoping.
	await stageEach(cwd, paths);
	const numstat = await run(cwd, [
		"diff",
		"--cached",
		"--numstat",
		"--",
		...paths,
	]);
	const diff = await run(cwd, ["diff", "--cached", "--", ...paths]);
	let added = 0;
	let removed = 0;
	for (const line of numstat.stdout.split("\n")) {
		if (line.trim() === "") continue;
		const [a, r] = line.split("\t");
		const aNum = Number.parseInt(a ?? "0", 10);
		const rNum = Number.parseInt(r ?? "0", 10);
		if (Number.isFinite(aNum)) added += aNum;
		if (Number.isFinite(rNum)) removed += rNum;
	}
	const hunks = (diff.stdout.match(/^@@/gm) ?? []).length;
	// Pure renames with 100% similarity show up in the diff text as
	// `rename from <old> / rename to <new>` instead of `+`/`-` lines,
	// so the numstat counts them as 0/0. The diff text is the only
	// reliable signal.
	const hasRename = /^rename (from|to) /m.test(diff.stdout);
	return { added, removed, hunks, diff: diff.stdout, hasRename };
}

/**
 * Stage `paths` and create a single commit constrained to those paths.
 * Returns the short SHA on success. When nothing is staged for `paths`,
 * returns `{ sha: null, skipped: true }` so the caller can render
 * "no commit needed".
 */
export async function commitPaths(
	cwd: string,
	paths: string[],
	message: string,
	options: { allowEmpty?: boolean } = {},
): Promise<CommitResult> {
	if (paths.length === 0) {
		return { sha: null, skipped: true, reason: "no paths" };
	}
	// Stage each path with the right verb (add vs rm). See
	// `stageEach` for why a single `git add -A` doesn't work here.
	const staged = await stageEach(cwd, paths);
	if (
		staged.failed.length > 0 &&
		staged.added.length === 0 &&
		staged.removed.length === 0
	) {
		return {
			sha: null,
			skipped: true,
			reason: "git stage failed",
			stderr: staged.failed.map((f) => f.stderr).join("\n"),
		};
	}
	const status = await run(cwd, [
		"diff",
		"--cached",
		"--name-only",
		"--",
		...paths,
	]);
	if (status.code !== 0) {
		return {
			sha: null,
			skipped: true,
			reason: "git status failed",
			stderr: status.stderr,
		};
	}
	if (status.stdout.trim() === "" && !options.allowEmpty) {
		return { sha: null, skipped: true, reason: "nothing to commit" };
	}
	// `--only` ignores any other staged content and refuses to include
	// paths outside the pathspec, so the commit can never sweep up the
	// user's unrelated work. The trailing `--` plus pathspec is the
	// belt-and-braces form of the same guarantee.
	const commit = await run(cwd, [
		"commit",
		"--only",
		"--no-verify",
		"--no-gpg-sign",
		"-m",
		message,
		"--",
		...paths,
	]);
	if (commit.code !== 0) {
		return {
			sha: null,
			skipped: false,
			reason: "git commit failed",
			stderr: commit.stderr,
		};
	}
	const shaResult = await run(cwd, ["rev-parse", "--short", "HEAD"]);
	if (shaResult.code !== 0) {
		return {
			sha: null,
			skipped: false,
			reason: "missing HEAD",
			stderr: shaResult.stderr,
		};
	}
	return { sha: shaResult.stdout.trim(), skipped: false };
}

/**
 * Stage each path with the right git verb. We can't use a single
 * `git add -A -- <paths>` because git tries to match the pathspec
 * against the *worktree* and fails for paths that have been deleted
 * (the source of a rename). And we can't use a blanket `git add -A`
 * (no pathspec) because that sweeps the whole worktree, defeating
 * the per-edit scoping the committer relies on for `--only` to mean
 * anything.
 *
 * The workaround: walk `paths`, check whether each one exists on
 * disk, and dispatch to `git add` or `git rm` accordingly. The
 * `git rm` form records the deletion in the index without needing
 * the file to be present; git then infers the rename from the
 * similarity with the surviving destination.
 */
async function stageEach(
	cwd: string,
	paths: string[],
): Promise<{
	added: string[];
	removed: string[];
	failed: { path: string; stderr: string }[];
}> {
	const result = {
		added: [] as string[],
		removed: [] as string[],
		failed: [] as { path: string; stderr: string }[],
	};
	for (const p of paths) {
		const exists = await pathExists(cwd, p);
		const verb = exists ? "add" : "rm";
		const r = await run(cwd, [verb, "--", p]);
		if (r.code === 0) {
			if (verb === "add") result.added.push(p);
			else result.removed.push(p);
		} else {
			result.failed.push({ path: p, stderr: r.stderr });
		}
	}
	return result;
}

async function pathExists(cwd: string, path: string): Promise<boolean> {
	const r = await run(cwd, ["ls-files", "--error-unmatch", "--", path]);
	// `ls-files --error-unmatch` exits 1 if the path isn't tracked.
	// For an untracked file that's been created, we also want to
	// treat it as "exists" so we use `git add` rather than `git rm`.
	if (r.code === 0) return true;
	const stat = await run(cwd, [
		"ls-files",
		"--others",
		"--exclude-standard",
		"--",
		path,
	]);
	if (r.code !== 0 && stat.code === 0 && stat.stdout.trim() !== "") return true;
	// Fall back to the on-disk stat: the path may not be tracked yet
	// (e.g. an Edit that created a brand-new file), or git might not
	// be aware of it for some other reason.
	const proc = Bun.spawnSync(["test", "-e", path], { cwd });
	return proc.exitCode === 0;
}
