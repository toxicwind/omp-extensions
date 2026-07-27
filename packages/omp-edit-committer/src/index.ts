/**
 * Public entry point. omp's extension loader imports the default export
 * from this module. We re-export from `./extension.ts` so embedders can
 * pull the factory directly via the package root.
 */
export { default } from "./extension.ts";
export { buildMessage, fillHunkSha, summarize } from "./message.ts";
export type { CommitMessage, DiffSummary, EditKind } from "./message.ts";
export {
	COMMIT_MESSAGE_TYPE,
	makeCommitRecord,
	renderCommitMessage,
} from "./renderer.ts";
export type { CommitRecord } from "./renderer.ts";
