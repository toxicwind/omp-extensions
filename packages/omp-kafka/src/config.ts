/**
 * Config loader for omp-kafka.
 *
 * Resolution order (first hit wins):
 *   1. `KAFKA_CONFIG` env var (absolute path).
 *   2. `<cwd>/kafka.yml`.
 *   3. `<cwd>/.omp/kafka.yml`.
 *   4. `~/.omp/agent/kafka.yml`.
 *
 * The file is parsed with the `yaml` package for full YAML support.
 * A JSON file (`.kafka.json` or any `.json`) is parsed with `JSON.parse`.
 *
 * The loader is intentionally strict: an unknown shape, a duplicate
 * consumer name, or a missing `brokers`/`topics` array all throw. The
 * factory catches and reports the error, then runs the extension in
 * disabled mode.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
	ConsumerConfig,
	KafkaYamlConfig,
	ResolvedConsumer,
} from "./types.ts";

/// Ambient Bun global for typecheck (no @types/bun dependency at runtime).
declare const Bun: { file(path: string): { text(): Promise<string> } };

const DEFAULTS = {
	clientId: "omp-kafka",
	fromBeginning: false,
	notify: true,
	maxQueue: 200,
	autoDeliverAs: "steer" as const,
};

/** Where the loader looked. Returned to the caller so we can log it. */
export interface LoadResult {
	config: ResolvedConsumer[];
	source: string | null;
	errors: string[];
}

/** Public entry point. Returns an empty `config` on any error. */
export async function loadConfig(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<LoadResult> {
	const errors: string[] = [];
	const source = resolveConfigPath(cwd, env);
	if (!source) {
		return {
			config: [],
			source: null,
			errors: ["no kafka.yml found and KAFKA_CONFIG not set"],
		};
	}

	let raw: unknown;
	try {
		const text = await readText(source);
		raw = source.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
	} catch (err) {
		errors.push(`failed to parse ${source}: ${(err as Error).message}`);
		return { config: [], source, errors };
	}

	const validated = validate(raw, errors);
	if (errors.length > 0) {
		return { config: [], source, errors };
	}

	const seen = new Set<string>();
	const resolved: ResolvedConsumer[] = [];
	for (const c of validated.consumers) {
		if (seen.has(c.name)) {
			errors.push(`duplicate consumer name: ${c.name}`);
			continue;
		}
		seen.add(c.name);
		resolved.push(applyDefaults(c));
	}

	if (resolved.length === 0) {
		errors.push("kafka.yml contains no consumers");
	}

	return { config: resolved, source, errors };
}

function resolveConfigPath(cwd: string, env: NodeJS.ProcessEnv): string | null {
	const candidates: string[] = [];
	if (env.KAFKA_CONFIG) {
		candidates.push(
			isAbsolute(env.KAFKA_CONFIG)
				? env.KAFKA_CONFIG
				: resolvePath(cwd, env.KAFKA_CONFIG),
		);
	}
	candidates.push(resolvePath(cwd, "kafka.yml"));
	candidates.push(resolvePath(cwd, ".omp", "kafka.yml"));
	candidates.push(resolvePath(homedir(), ".omp", "agent", "kafka.yml"));
	return candidates.find((c) => existsSync(c)) ?? null;
}

async function readText(path: string): Promise<string> {
	if (typeof Bun !== "undefined") return Bun.file(path).text();
	return readFileSync(path, "utf8");
}

// --- Validation ------------------------------------------------------------

function validate(raw: unknown, errors: string[]): KafkaYamlConfig {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		errors.push("top-level must be a mapping");
		return { consumers: [] };
	}
	const root = raw as Record<string, unknown>;
	const consumersRaw = root.consumers;
	if (!Array.isArray(consumersRaw)) {
		errors.push("missing or non-array `consumers`");
		return { consumers: [] };
	}
	const consumers: ConsumerConfig[] = [];
	consumersRaw.forEach((entry, idx) => {
		const path = `consumers[${idx}]`;
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			errors.push(`${path}: must be a mapping`);
			return;
		}
		const e = entry as Record<string, unknown>;
		if (typeof e.name !== "string" || e.name.length === 0) {
			errors.push(`${path}.name: required string`);
			return;
		}
		if (e.mode !== "auto" && e.mode !== "pull") {
			errors.push(`${path}.mode: must be "auto" or "pull"`);
			return;
		}
		if (
			!Array.isArray(e.brokers) ||
			e.brokers.length === 0 ||
			!e.brokers.every((b) => typeof b === "string" && b.length > 0)
		) {
			errors.push(`${path}.brokers: required non-empty array of strings`);
			return;
		}
		if (
			!Array.isArray(e.topics) ||
			e.topics.length === 0 ||
			!e.topics.every((t) => typeof t === "string" && t.length > 0)
		) {
			errors.push(`${path}.topics: required non-empty array of strings`);
			return;
		}
		consumers.push(e as unknown as ConsumerConfig);
	});
	return { consumers };
}

function applyDefaults(c: ConsumerConfig): ResolvedConsumer {
	return {
		name: c.name,
		mode: c.mode,
		brokers: c.brokers.slice(),
		clientId: c.clientId ?? DEFAULTS.clientId,
		groupId: c.groupId ?? `omp-kafka-${c.name}`,
		topics: c.topics.slice(),
		fromBeginning: c.fromBeginning ?? DEFAULTS.fromBeginning,
		notify: c.notify ?? DEFAULTS.notify,
		maxQueue: c.maxQueue ?? DEFAULTS.maxQueue,
		auto: {
			deliverAs: c.auto?.deliverAs ?? DEFAULTS.autoDeliverAs,
			prefix: c.auto?.prefix ?? `[kafka:${c.name}] `,
		},
		sasl: c.sasl,
		ssl: c.ssl ?? false,
		clientConfig: c.clientConfig ?? {},
	};
}

// Re-export for embedders.
export { parseYaml };
