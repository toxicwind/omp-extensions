/**
 * omp-edit-committer extension entry point.
 *
 * Hooks the Edit and Write tools so every successful edit produces a
 * descriptive git commit on the user's behalf, then surfaces the commit
 * SHA via a custom message entry that the TUI renders directly under the
 * Edit tool header (see the white-circle callout in the project docs).
 *
 * Flow:
 *
 *   tool_call  (edit|write)  ─►  stash { paths, intentHint } by toolCallId
 *   tool_result (edit|write) ─►  stat via git, build message, commit
 *                                 (constrained to the target paths),
 *                                 appendEntry ("edit-committer", record)
 *
 * The committer is conservative: it only acts when
 *
 *   - cwd is inside a git working tree
 *   - `user.name` + `user.email` are configured
 *   - the diff actually changed the index (no empty commits)
 *   - the tool succeeded (`isError === false`)
 *
 * Any of those failing causes the extension to silently no-op — the agent
 * sees the normal Edit/Write result and the user is not interrupted.
 */
import type {
	EditToolCallEvent,
	EditToolDetails,
	EditToolResultEvent,
	ExtensionAPI,
	ExtensionContext,
	WriteToolCallEvent,
	WriteToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";
import {
	type RepoProbe,
	commitPaths,
	probeRepo,
	statStagedPaths,
} from "./git.ts";
import {
	type DiffSummary,
	type EditKind,
	buildMessage,
	summarize,
} from "./message.ts";
import {
	COMMIT_MESSAGE_TYPE,
	type CommitRecord,
	makeCommitRecord,
	renderCommitMessage,
} from "./renderer.ts";

/** Tool names we auto-commit. */
type CommitTool = "edit" | "write";

/** Per-tool-call scratch state, kept off the LLM-facing API surface. */
interface PendingEdit {
	paths: string[];
	intentHint?: string;
}

const DEBUG = process.env.OMP_EDIT_COMMITTER_DEBUG === "1";
const DISABLED = process.env.OMP_EDIT_COMMITTER_DISABLED === "1";

function debug(...args: unknown[]): void {
	if (DEBUG) {
		// eslint-disable-next-line no-console
		console.error("[omp-edit-committer]", ...args);
	}
}

/**
 * Cache the per-cwd repo probe. The probe is read-only and rarely changes
 * during a session, so we amortize it across every edit in the same cwd.
 */
const repoCache = new Map<string, Promise<RepoProbe>>();

function probeFor(cwd: string): Promise<RepoProbe> {
	const cached = repoCache.get(cwd);
	if (cached) return cached;
	const p = probeRepo(cwd).catch((err) => {
		// Drop the failed promise so the next call retries; git might be
		// installed later in the session, or the user might `git init`.
		repoCache.delete(cwd);
		debug("probeRepo failed:", err);
		return {
			insideRepo: false,
			toplevel: null,
			identityConfigured: false,
		} satisfies RepoProbe;
	});
	repoCache.set(cwd, p);
	return p;
}

function pickKind(
	toolName: CommitTool,
	details: EditToolDetails | undefined,
): EditKind {
	if (toolName === "write") return "write";
	// `EditToolDetails["op"]` is "create" | "delete" | "update"; rename is
	// not represented here (rename uses a separate `move` field).
	const op = details?.op;
	if (op === "create" || op === "delete") return op;
	return "edit";
}

function extractEditPaths(input: Record<string, unknown>): string[] {
	// Replace mode: { path, edits: [{ old_text, new_text, all? }] }
	const top = input.path;
	if (typeof top === "string" && top.length > 0) return [top];
	// Apply-patch / multi-file mode: { edits: [{ path, ... }] }
	const edits = input.edits;
	if (Array.isArray(edits)) {
		const paths: string[] = [];
		for (const e of edits) {
			if (e && typeof e === "object") {
				const p = (e as Record<string, unknown>).path;
				if (typeof p === "string" && p.length > 0) paths.push(p);
			}
		}
		return paths;
	}
	return [];
}

function extractWritePaths(input: Record<string, unknown>): string[] {
	const p = input.path;
	return typeof p === "string" && p.length > 0 ? [p] : [];
}

function extractIntentHint(input: Record<string, unknown>): string | undefined {
	// LLMs can pass an `intent` / `commit_message` / `commitMessage` field on
	// the tool call. We don't require it; without one, the message builder
	// falls back to diff-derived text.
	const hint = input.intent ?? input.commit_message ?? input.commitMessage;
	return typeof hint === "string" && hint.trim() !== ""
		? hint.trim()
		: undefined;
}

function collectPathsFromDetails(
	details: EditToolDetails | undefined,
): string[] {
	if (!details) return [];
	if (
		Array.isArray(details.perFileResults) &&
		details.perFileResults.length > 0
	) {
		return details.perFileResults.map((p) => p.path);
	}
	if (typeof details.path === "string" && details.path !== "")
		return [details.path];
	return [];
}

export default function editCommitterExtension(pi: ExtensionAPI): void {
	pi.setLabel("Edit Committer");

	if (DISABLED) {
		debug("OMP_EDIT_COMMITTER_DISABLED=1 — extension no-ops");
		return;
	}

	// Scratch state shared across tool_call → tool_result. Keyed by toolCallId.
	const pending = new Map<string, PendingEdit>();

	// Register the custom message renderer once; it pulls a CommitRecord
	// out of `details` and renders the commit badge.
	pi.registerMessageRenderer(
		COMMIT_MESSAGE_TYPE,
		renderCommitMessage as Parameters<typeof pi.registerMessageRenderer>[1],
	);

	// ---- tool_call ---------------------------------------------------------

	pi.on("tool_call", async (event) => {
		if (event.type !== "tool_call") return;
		const ev = event as EditToolCallEvent | WriteToolCallEvent;
		if (ev.toolName !== "edit" && ev.toolName !== "write") return;
		const input = ev.input as Record<string, unknown>;
		const paths =
			ev.toolName === "edit"
				? extractEditPaths(input)
				: extractWritePaths(input);
		if (paths.length === 0) return;
		pending.set(ev.toolCallId, {
			paths,
			intentHint: extractIntentHint(input),
		});
	});

	// ---- tool_result -------------------------------------------------------

	pi.on("tool_result", async (event, ctx) => {
		if (event.type !== "tool_result") return;
		const ev = event as EditToolResultEvent | WriteToolResultEvent;
		if (ev.toolName !== "edit" && ev.toolName !== "write") return;
		const initial = pending.get(ev.toolCallId);
		pending.delete(ev.toolCallId);
		if (!initial) return;
		if (event.isError) {
			debug("edit/write failed; skipping commit", ev.toolCallId);
			return;
		}

		const details = ev.toolName === "edit" ? ev.details : undefined;
		// Edit may surface paths inside `details` that weren't in the call
		// (apply-patch / multi-file). Prefer those when present.
		const detailsPaths =
			ev.toolName === "edit" ? collectPathsFromDetails(details) : [];
		const paths = detailsPaths.length > 0 ? detailsPaths : initial.paths;
		if (paths.length === 0) return;

		const kind = pickKind(ev.toolName, details);
		await runCommit(pi, ctx, {
			kind,
			paths,
			intentHint: initial.intentHint,
			details,
		});
	});

	// Slash command: re-prints a hint about the badge so the user can find
	// it after scrolling past the Edit tool result.
	pi.registerCommand("edit-committer-status", {
		description: "Show a hint about the auto-commit badge.",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				"edit-committer: every Edit/Write produces a commit; the SHA is rendered directly under the tool result.",
				"info",
			);
		},
	});
}

interface RunCommitArgs {
	kind: EditKind;
	paths: string[];
	intentHint: string | undefined;
	details: EditToolDetails | undefined;
}

/**
 * Build the {@link DiffSummary} the message builder consumes.
 *
 * The message builder is the only place that knows how to phrase the
 * Intent / Trade-offs / Diagram sections, but it needs accurate
 * numbers. We use `git diff --cached` as the source of truth for the
 * stat (it works for both Edit and Write and never disagrees with the
 * tree we are about to commit), and `summarize()` for the per-file
 * metadata Edit already collected.
 */
function buildSummary(
	paths: string[],
	gitStat: { added: number; removed: number; hunks: number; diff: string },
	details: EditToolDetails | undefined,
): DiffSummary {
	const perFile = details?.perFileResults;
	const fromEvent = summarize(paths, details, perFile);
	// `summarize()` parses the per-file / single-file diffs from the
	// event payload. We then overwrite the stat fields with the
	// git-derived numbers so the message describes the commit that
	// is actually about to land (the event's `details.diff` is a
	// preview and can disagree with the on-disk state in edge cases
	// like concurrent edits).
	return {
		...fromEvent,
		added: gitStat.added,
		removed: gitStat.removed,
		hunks: gitStat.hunks,
		firstAddedLine: firstLine(gitStat.diff, "+") ?? fromEvent.firstAddedLine,
		firstRemovedLine:
			firstLine(gitStat.diff, "-") ?? fromEvent.firstRemovedLine,
	};
}

function firstLine(diff: string, prefix: "+" | "-"): string | null {
	for (const raw of diff.split("\n")) {
		if (
			raw.startsWith(prefix) &&
			!raw.startsWith(`${prefix}++`) &&
			!raw.startsWith(`${prefix}--`)
		) {
			return raw.slice(1).trim();
		}
	}
	return null;
}

async function runCommit(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	args: RunCommitArgs,
): Promise<void> {
	const cwd = ctx.cwd;
	const probe = await probeFor(cwd);
	if (!probe.insideRepo) {
		debug("cwd is not a git repo; skipping", cwd);
		return;
	}
	if (!probe.identityConfigured) {
		debug("git user.name/user.email not configured; skipping");
		return;
	}

	// Stat the staged paths via git itself. This is the single source
	// of truth — it works for both Edit (which carries a `details.diff`)
	// and Write (which never does), and it sees whatever the file
	// actually contains on disk rather than the tool event's possibly
	// stale view.
	const stat = await statStagedPaths(cwd, args.paths);
	if (stat.added === 0 && stat.removed === 0) {
		debug("paths produced no staged changes; skipping commit", args.paths);
		return;
	}

	const summary = buildSummary(args.paths, stat, args.details);
	const message = buildMessage(summary, {
		kind: args.kind,
		intentHint: args.intentHint,
	});
	const result = await commitPaths(cwd, args.paths, message.body);
	if (!result.sha) {
		debug("commit skipped:", result.reason, result.stderr);
		return;
	}
	debug("committed", result.sha, "for", args.paths);

	const record: CommitRecord = makeCommitRecord({
		sha: result.sha,
		subject: message.subject,
		kind: args.kind,
		paths: summary.paths,
		added: summary.added,
		removed: summary.removed,
		hunks: summary.hunks,
		primaryPath: summary.paths[0] ?? args.paths[0] ?? "",
		repoRoot: probe.toplevel ?? cwd,
	});
	pi.appendEntry(COMMIT_MESSAGE_TYPE, record);
}
