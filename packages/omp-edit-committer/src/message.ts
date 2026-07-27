/**
 * Build a descriptive commit message for a single edit.
 *
 * The goal: when a reviewer runs `git show <sha>` (or `hunk` on top of the
 * modem-dev/hunk CLI) they see enough to understand *what* changed, *why*,
 * and *what we chose to give up* — without re-reading the surrounding files.
 *
 * Sections emitted (when applicable):
 *
 *   <type>(<scope>): <subject>          ← subject, ≤ 72 chars
 *
 *   Intent
 *     - <one bullet on what the change is meant to accomplish>
 *
 *   Trade-offs
 *     - <one bullet on a deliberate non-goal or constraint>
 *
 *   Diagram                       (only when complex: multi-file, multi-hunk,
 *                                   signature change, or state-machine edit)
 *     <ASCII art illustrating the new flow>
 *
 *   Refs: <files>, <+added>/-<removed>, N hunks
 *   hunk: <sha>    (filled by commit() — left blank in the builder)
 *
 * The renderer is intentionally pure: no I/O, no git calls. `buildMessage`
 * returns a string and a `MessageMeta` blob the extension uses to render
 * the in-TUI commit badge.
 */
import type {
	EditToolDetails,
	EditToolPerFileResult,
} from "@oh-my-pi/pi-coding-agent";

/** Lightweight handle to the parts of a diff we care about. */
export interface DiffSummary {
	/** Absolute or repo-relative paths, de-duplicated, in input order. */
	paths: string[];
	/** `+x/-y` line totals across all per-file diffs. */
	added: number;
	removed: number;
	/** Number of `@@ ... @@` hunks across the unified diff. */
	hunks: number;
	/** True when at least one edit was a create, delete, or rename. */
	hasStructuralChange: boolean;
	/** True when the diff touches >= 2 distinct files. */
	hasMultiFile: boolean;
	/** True when the diff has >= 3 hunks (heuristic for "complex"). */
	hasManyHunks: boolean;
	/** First-line preview of the new code, used to seed the intent line. */
	firstAddedLine: string | null;
	/** First-line preview of the removed code, used as a "before" hint. */
	firstRemovedLine: string | null;
}

/** Operation the edit corresponds to. Determines the subject-line verb. */
export type EditKind = "edit" | "write" | "create" | "delete" | "rename";

/** Result of `buildMessage`. */
export interface CommitMessage {
	/** Full commit message, ready for `git commit -m`. */
	body: string;
	/** Short subject used for status / TUI badge. */
	subject: string;
	/** Operation token used in the subject (e.g. `edit`, `write`, `create`). */
	kind: EditKind;
	/** Summary the renderer turns into a one-line badge. */
	summary: DiffSummary;
}

/** Threshold above which we emit the diagram block. Tuned to err verbose. */
const COMPLEX_HUNK_THRESHOLD = 3;
/** "Complex" path count (multi-file edits usually mean a refactor). */
const MULTI_FILE_THRESHOLD = 2;

interface IntentVerb {
	token: RegExp;
	verb: string;
}

const INTENT_VERBS: ReadonlyArray<IntentVerb> = [
	{ token: /\bdrop|remove|delete\b/i, verb: "drop" },
	{ token: /\badd|introduce|implement\b/i, verb: "add" },
	{ token: /\bfix|repair|patch\b/i, verb: "fix" },
	{ token: /\brefactor|restructure|reorganize|rewrite\b/i, verb: "refactor" },
	{ token: /\boptimi[sz]e|perf\b/i, verb: "optimize" },
	{ token: /\bupdat|adjust|tweak|bump\b/i, verb: "update" },
	{ token: /\brenam|move\b/i, verb: "rename" },
	{ token: /\bdoc|comment|note\b/i, verb: "docs" },
	{ token: /\btest\b/i, verb: "test" },
];

interface FlatFileDiff {
	path: string;
	diff: string;
	op?: EditToolPerFileResult["op"];
}

/** Reduce the raw edit event into a {@link DiffSummary}. */
export function summarize(
	paths: string[],
	details: EditToolDetails | undefined,
	perFile: EditToolPerFileResult[] | undefined,
): DiffSummary {
	const files = collectDiffs(paths, details, perFile);
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const p of paths) {
		if (seen.has(p)) continue;
		seen.add(p);
		unique.push(p);
	}

	let added = 0;
	let removed = 0;
	let hunks = 0;
	let firstAdded: string | null = null;
	let firstRemoved: string | null = null;
	let hasStructural = false;

	for (const f of files) {
		for (const line of f.diff.split("\n")) {
			if (line.startsWith("@@")) {
				hunks++;
				continue;
			}
			if (line.startsWith("+++") || line.startsWith("---")) continue;
			if (line.startsWith("+")) {
				added++;
				if (firstAdded === null) firstAdded = line.slice(1).trim();
			} else if (line.startsWith("-")) {
				removed++;
				if (firstRemoved === null) firstRemoved = line.slice(1).trim();
			}
		}
		// EditToolPerFileResult.op is "create" | "delete" | "update"; the agent
		// uses "update" for plain edits, so we only treat create/delete as
		// structural changes (rename uses a separate `move` field).
		if (f.op === "create" || f.op === "delete") hasStructural = true;
	}
	if (details?.op === "create" || details?.op === "delete") {
		hasStructural = true;
	}

	return {
		paths: unique,
		added,
		removed,
		hunks,
		hasStructuralChange: hasStructural,
		hasMultiFile: unique.length >= MULTI_FILE_THRESHOLD,
		hasManyHunks: hunks >= COMPLEX_HUNK_THRESHOLD,
		firstAddedLine: firstAdded,
		firstRemovedLine: firstRemoved,
	};
}

function collectDiffs(
	paths: string[],
	details: EditToolDetails | undefined,
	perFile: EditToolPerFileResult[] | undefined,
): FlatFileDiff[] {
	if (perFile && perFile.length > 0) {
		return perFile.map((entry) => ({
			path: entry.path,
			diff: entry.diff,
			op: entry.op,
		}));
	}
	if (details) {
		return [
			{
				path: details.path ?? paths[0] ?? "",
				diff: details.diff,
				op: details.op,
			},
		];
	}
	// `write` tool details is `undefined`; fall back to one entry per path
	// with an empty diff. We still know *which* files were touched.
	return paths.map((p) => ({ path: p, diff: "" }));
}

/** Pick the verb that best matches the first added line, if any. */
function detectVerb(added: string | null, kind: EditKind): string {
	if (kind === "create") return "add";
	if (kind === "delete") return "drop";
	if (kind === "rename") return "rename";
	if (kind === "write")
		return added ? (firstVerbMatch(added) ?? "update") : "update";
	return added ? (firstVerbMatch(added) ?? "edit") : "edit";
}

function firstVerbMatch(text: string): string | null {
	for (const { token, verb } of INTENT_VERBS) {
		if (token.test(text)) return verb;
	}
	return null;
}

/** Short scope derived from paths: directory or filename stem. */
function detectScope(paths: string[]): string {
	if (paths.length === 0) return "config";
	const first = paths[0] ?? "";
	const lastSlash = first.lastIndexOf("/");
	if (paths.length > 1) {
		// Multi-file: prefer the shared directory.
		const dirs = new Set(paths.map((p) => p.slice(0, p.lastIndexOf("/"))));
		if (dirs.size === 1) {
			const d = [...dirs][0] ?? "";
			return shortenScope(d) || "config";
		}
		return "multi";
	}
	const stem = first.slice(lastSlash + 1).replace(/\.[^.]+$/, "");
	if (stem) return stem;
	return (
		shortenScope(lastSlash > 0 ? first.slice(0, lastSlash) : "") || "config"
	);
}

function shortenScope(scope: string): string {
	if (!scope) return "";
	const parts = scope.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? scope;
}

/** Build a 72-char-or-fewer subject line. */
export function buildSubject(
	summary: DiffSummary,
	kind: EditKind,
	intentHint?: string,
): string {
	const verb = detectVerb(summary.firstAddedLine ?? intentHint ?? null, kind);
	const scope = detectScope(summary.paths);
	const subject = intentHint
		? sanitizeSubject(intentHint)
		: summarizeFromDiff(summary, verb);
	return trimSubject(`${verb}(${scope}): ${subject}`);
}

function summarizeFromDiff(summary: DiffSummary, verb: string): string {
	const first = summary.firstAddedLine;
	if (first) return `${verb} ${first.replace(/\s+/g, " ").slice(0, 64)}`;
	if (summary.firstRemovedLine) {
		return `${verb} ${summary.firstRemovedLine.replace(/\s+/g, " ").slice(0, 64)}`;
	}
	return `${verb} ${summary.paths[0] ?? "file"}`;
}

function sanitizeSubject(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.;:]+$/, "");
}

function trimSubject(s: string): string {
	if (s.length <= 72) return s;
	return `${s.slice(0, 69)}...`;
}

/** Build the "Intent" block. Pulls the user's hint when present. */
function buildIntent(
	intentHint: string | undefined,
	summary: DiffSummary,
): string[] {
	if (intentHint) return [`- ${sanitizeSubject(intentHint)}`];
	if (summary.firstAddedLine)
		return [`- ${sanitizeSubject(summary.firstAddedLine)}`];
	if (summary.hasStructuralChange) {
		return [
			`- ${summary.paths[0] ?? "file"} ${summary.hunks === 0 ? "structure" : "touched"}`,
		];
	}
	return ["- no semantic change; pure formatting or whitespace"];
}

/**
 * Build the "Trade-offs" block. We always emit at least one bullet — if no
 * automatic signal is present we fall back to "no semantic change" so the
 * reviewer knows the diff is shape-only.
 */
function buildTradeoffs(summary: DiffSummary, kind: EditKind): string[] {
	const out: string[] = [];
	if (summary.added === 0 && summary.removed > 0) {
		out.push(
			"- net removal; callers depending on the removed API/symbol will break",
		);
	}
	if (summary.hasMultiFile && !summary.hasStructuralChange) {
		out.push(
			"- spans multiple files; reviewer should confirm coupling between sites",
		);
	}
	if (summary.hasManyHunks) {
		out.push("- many hunks; consider splitting the commit before review");
	}
	if (kind === "create") {
		out.push(
			"- new file; not yet exercised by any caller, so hidden coupling is possible",
		);
	}
	if (kind === "delete") {
		out.push(
			"- the file is gone; no greppable tombstones, search the old name manually",
		);
	}
	if (out.length === 0) {
		out.push(
			"- kept the diff shape minimal; no refactor / no rename / no formatting churn",
		);
	}
	return out;
}

/**
 * Render an ASCII block when the change is "complex" by the heuristics in
 * {@link summarize}. We don't try to derive a *true* control-flow diagram
 * from the diff — that's a job for the LLM at edit time, not the committer.
 * We emit a small, well-defined scaffold the LLM can replace with prose.
 */
function buildDiagram(summary: DiffSummary, kind: EditKind): string[] {
	if (
		!summary.hasMultiFile &&
		!summary.hasManyHunks &&
		!summary.hasStructuralChange
	) {
		return [];
	}
	const op =
		kind === "create"
			? "create"
			: kind === "delete"
				? "delete"
				: kind === "rename"
					? "rename"
					: kind === "write"
						? "overwrite"
						: `edit (+${summary.added}/-${summary.removed})`;
	const lines: string[] = [
		"```",
		"Edit shape:",
		"  before           after",
		"  ───────          ─────",
	];
	for (const p of summary.paths.slice(0, 4)) {
		lines.push(`  ${p}  ──►  ${op}`);
	}
	if (summary.paths.length > 4) {
		lines.push(`  (+${summary.paths.length - 4} more)`);
	}
	lines.push("```");
	return lines;
}

function buildRefs(summary: DiffSummary): string {
	const pathList =
		summary.paths.length > 6
			? `${summary.paths.slice(0, 6).join(", ")} (+${summary.paths.length - 6} more)`
			: summary.paths.join(", ");
	return `Refs: ${pathList}, +${summary.added}/-${summary.removed}, ${summary.hunks} hunks`;
}

/** Compose the full commit message from a summary. */
export function buildMessage(
	summary: DiffSummary,
	opts: { kind: EditKind; intentHint?: string } = { kind: "edit" },
): CommitMessage {
	const subject = buildSubject(summary, opts.kind, opts.intentHint);
	const sections: string[] = [subject, ""];
	const intent = buildIntent(opts.intentHint, summary);
	if (intent.length > 0) sections.push("Intent", ...intent, "");
	const tradeoffs = buildTradeoffs(summary, opts.kind);
	if (tradeoffs.length > 0) sections.push("Trade-offs", ...tradeoffs, "");
	const diagram = buildDiagram(summary, opts.kind);
	if (diagram.length > 0) sections.push("Diagram", ...diagram, "");
	sections.push(buildRefs(summary));
	// `hunk: <sha>` is a footer modem-dev/hunk can pick up directly to
	// re-render the diff in its own viewer. The committer fills the SHA
	// after `git commit` succeeds.
	sections.push("hunk: ");
	return {
		body: `${sections.join("\n").trimEnd()}\n`,
		subject,
		kind: opts.kind,
		summary,
	};
}

/** Substitute the SHA into the `hunk:` footer once `git commit` returns. */
export function fillHunkSha(body: string, sha: string): string {
	// `[ \t]*` (not `\s*`) so we don't gobble the trailing newline that
	// separates the footer from the rest of the message.
	return body.replace(/^hunk:[ \t]*$/m, `hunk: ${sha}`);
}
