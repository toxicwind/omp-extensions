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
 *   tool_call  (edit|write)  ─►  stash { paths, kind, intentHint } by toolCallId
 *   tool_result (edit|write) ─►  summarize diff → buildMessage → git commit
 *                                 → appendEntry ("edit-committer", record)
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
	EditToolPerFileResult,
	EditToolResultEvent,
	ExtensionAPI,
	ExtensionContext,
	WriteToolCallEvent,
	WriteToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";
import { type RepoProbe, commitPaths, probeRepo } from "./git.ts";
import {
	type EditKind,
	buildMessage,
	fillHunkSha,
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
	kind: EditKind;
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

function pickKind(toolName: CommitTool, details: unknown): EditKind {
	if (toolName === "write") return "write";
	const op = (details as { op?: string } | undefined)?.op;
	if (op === "create" || op === "delete" || op === "rename") return op;
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

function collectPathsFromDetails(ev: EditToolResultEvent): string[] {
	const details = ev.details;
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
			kind: pickKind(ev.toolName, input),
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
		const perFile = details?.perFileResults;
		// Edit may surface paths inside `details` that weren't in the call
		// (apply-patch / multi-file). Prefer those when present.
		const detailsPaths =
			ev.toolName === "edit" ? collectPathsFromDetails(ev) : [];
		const paths = detailsPaths.length > 0 ? detailsPaths : initial.paths;
		if (paths.length === 0) return;

		await runCommit(pi, ctx, {
			toolName: ev.toolName,
			kind: initial.kind,
			paths,
			intentHint: initial.intentHint,
			details,
			perFile,
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
	toolName: CommitTool;
	kind: EditKind;
	paths: string[];
	intentHint: string | undefined;
	details: EditToolDetails | undefined;
	perFile: EditToolPerFileResult[] | undefined;
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

	const summary = summarize(args.paths, args.details, args.perFile);
	if (
		summary.added === 0 &&
		summary.removed === 0 &&
		!summary.hasStructuralChange
	) {
		debug("diff produced no lines; skipping commit", args.paths);
		return;
	}

	const message = buildMessage(summary, {
		kind: args.kind,
		intentHint: args.intentHint,
	});
	const result = await commitPaths(cwd, args.paths, message.body);
	if (!result.sha) {
		debug("commit skipped:", result.reason, result.stderr);
		return;
	}
	// `git commit` already wrote `message.body` to the object. The `hunk:`
	// footer is filled with the short SHA only when we amend (e.g. after a
	// manual fix); for now the committed blob carries the empty footer.
	// finalBody stays referenced for the future amend flow.
	const finalBody = fillHunkSha(message.body, result.sha);
	debug("committed", result.sha, "for", args.paths);
	void finalBody;

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
