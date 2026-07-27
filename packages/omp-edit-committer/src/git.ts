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
 * Stage a set of paths and create a single commit with the given message.
 * Returns the short SHA on success. When the index has no changes, returns
 * `{ sha: null, skipped: true }` so the caller can render "no commit needed".
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
	const add = await run(cwd, ["add", "--", ...paths]);
	if (add.code !== 0) {
		return {
			sha: null,
			skipped: true,
			reason: "git add failed",
			stderr: add.stderr,
		};
	}
	const status = await run(cwd, ["status", "--porcelain"]);
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
	const commit = await run(cwd, [
		"commit",
		"-m",
		message,
		"--no-verify",
		"--no-gpg-sign",
	]);
	if (commit.code !== 0) {
		// Common benign cause: a pre-commit hook in the user's repo that we
		// don't control. Surface stderr so the user can diagnose, but don't
		// pretend the commit happened.
		return {
			sha: null,
			skipped: false,
			reason: "git commit failed",
			stderr: commit.stderr,
		};
	}
	const sha = await run(cwd, ["rev-parse", "--short", "HEAD"]);
	if (sha.code !== 0) {
		return {
			sha: null,
			skipped: false,
			reason: "missing HEAD",
			stderr: sha.stderr,
		};
	}
	return { sha: sha.stdout.trim(), skipped: false };
}
