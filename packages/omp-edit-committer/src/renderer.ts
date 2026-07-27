/**
 * In-TUI renderer for the "edit-committer" custom message.
 *
 * The custom message itself is just a `CommitRecord` JSON blob; this file
 * turns it into a small, fixed-height badge that sits right under the
 * Edit tool result. The badge carries the short SHA, a one-line subject,
 * a stat row, and a `hunk` hint pointing reviewers to modem-dev/hunk.
 *
 * We compose a `Container` of `Text` rows because those are the only
 * public TUI primitives re-exported from `@oh-my-pi/pi-coding-agent`.
 * Anything fancier (Box, border, theme-aware padding) is internal.
 */
import { Container, Text } from "@oh-my-pi/pi-coding-agent";
import type { MessageRenderOptions, Theme } from "@oh-my-pi/pi-coding-agent";

/** Payload the extension stores via `pi.appendEntry("edit-committer", ...)`. */
export interface CommitRecord {
	sha: string;
	subject: string;
	kind: "edit" | "write" | "create" | "delete" | "rename";
	paths: string[];
	added: number;
	removed: number;
	hunks: number;
	/** Path of the file the Edit/Write tool touched. Used as the visual anchor. */
	primaryPath: string;
	/** Repo-relative cwd so the badge can disambiguate across worktrees. */
	repoRoot: string;
}

/** Custom entry name used both for `appendEntry` and `registerMessageRenderer`. */
export const COMMIT_MESSAGE_TYPE = "edit-committer";

/** Build the message entry payload. */
export function makeCommitRecord(input: {
	sha: string;
	subject: string;
	kind: CommitRecord["kind"];
	paths: string[];
	added: number;
	removed: number;
	hunks: number;
	primaryPath: string;
	repoRoot: string;
}): CommitRecord {
	return input;
}

export function renderCommitMessage(
	message: { details?: CommitRecord },
	_options: MessageRenderOptions,
	theme: Theme,
): Container {
	const data = message.details;
	if (!data) {
		// Defensive: an entry without details (e.g. older session log) gets a
		// single neutral line so the user isn't surprised by a blank block.
		const fallback = new Container();
		fallback.addChild(
			new Text(theme.fg("muted", "edit-committer: (missing record)"), 0, 0),
		);
		return fallback;
	}
	const container = new Container();
	// Row 1: SHA + kind + repo. This is the "white circle" content the user
	// expected to see in the Edit header — placed directly under the tool
	// result, anchored to the file via the subject.
	container.addChild(
		new Text(
			`${theme.fg("accent", "●")} ${theme.fg("text", `committed ${data.sha}`)} ${theme.fg(
				"dim",
				`via ${data.kind}`,
			)} ${theme.fg("muted", `(${data.repoRoot})`)}`,
			0,
			0,
		),
	);
	// Row 2: subject.
	container.addChild(new Text(theme.fg("toolTitle", data.subject), 0, 0));
	// Row 3: +/- stats, hunks, files.
	container.addChild(
		new Text(
			`  ${theme.fg("success", `+${data.added}`)} ${theme.fg("dim", "/")} ${theme.fg(
				"error",
				`-${data.removed}`,
			)} ${theme.fg(
				"muted",
				`· ${data.hunks} hunk${data.hunks === 1 ? "" : "s"} · ${data.paths.length} file${data.paths.length === 1 ? "" : "s"}`,
			)}`,
			0,
			0,
		),
	);
	// Row 4: hint to use modem-dev/hunk with this SHA, plus the primary path
	// so the reviewer can copy either into a shell.
	container.addChild(
		new Text(
			`  ${theme.fg("muted", "view with: ")}${theme.fg("accent", `hunk ${data.sha}`)} ${theme.fg(
				"dim",
				`(primary: ${data.primaryPath})`,
			)}`,
			0,
			0,
		),
	);
	return container;
}
