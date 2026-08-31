/**
 * Public entry point. omp's extension loader imports the default export
 * from this module. We re-export from `./extension.ts` so embedders can
 * pull the factory directly via the package root.
 */

export { default } from "./extension.ts";
export type {
	ConsumerMode,
	DeliverAs,
	KafkaMessageRecord,
	ResolvedConsumer,
} from "./types.ts";
