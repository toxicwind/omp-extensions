/**
 * omp-kafka extension entry point.
 *
 * Registered as a single default factory. On every `session_start` the
 * extension:
 *
 *   1. Loads and validates `kafka.yml`.
 *   2. Builds a `ManagedConsumer` per profile.
 *   3. Connects each consumer.
 *   4. Wires `auto` consumers to `pi.sendUserMessage(...)`.
 *   5. Registers the `kafka_consume` tool, the `/kafka` command family,
 *      and a small status widget.
 *
 * On `session_shutdown` every consumer is disconnected so the consumer
 * group offsets flush before the process exits.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { z } from "zod/v4";
import { type LoadResult, loadConfig } from "./config.ts";
import { type ConsumerStatus, ManagedConsumer } from "./consumer.ts";
import type {
	DeliverAs,
	KafkaMessageRecord,
	ResolvedConsumer,
} from "./types.ts";

const STATUS_KEY = "kafka";
const DEBUG = process.env.KAFKA_DEBUG === "1";
const DISABLED = process.env.KAFKA_DISABLED === "1";

function debug(...args: unknown[]): void {
	if (DEBUG) {
		// eslint-disable-next-line no-console
		console.error("[omp-kafka]", ...args);
	}
}

function formatRecord(r: KafkaMessageRecord): string {
	const head = r.key ? ` key=${r.key}` : "";
	return `[${r.timestamp}] ${r.topic}@${r.partition}/${r.offset}${head}\n${r.value}`;
}

function statusLabel(
	status: ConsumerStatus,
	depth: number,
	dropped: number,
): string {
	const droppedSuffix = dropped > 0 ? ` +${dropped} dropped` : "";
	switch (status.state) {
		case "idle":
			return `idle${droppedSuffix}`;
		case "connecting":
			return "connecting…";
		case "running":
			return `running (${depth})${droppedSuffix}`;
		case "paused":
			return `paused (${depth})${droppedSuffix}`;
		case "error":
			return `error: ${status.error}${droppedSuffix}`;
		case "disconnected":
			return "disconnected";
	}
}

// The zod schema is built once at module scope. The tool definition object
// itself is built inside `kafkaExtension` and explicitly typed via the
// `registerTool` parameter type, so TypeScript does not have to infer
// the recursive zod type from the call site.
const consumeParameters = z.object({
	consumer: z.string().optional(),
	limit: z.number().int().min(1).max(500).optional(),
	since: z.string().optional(),
});

export default function kafkaExtension(pi: ExtensionAPI): void {
	pi.setLabel("Kafka");

	const consumers = new Map<string, ManagedConsumer>();
	let activeLoad: LoadResult | null = null;

	const refreshStatus = (ctx: ExtensionContext): void => {
		if (consumers.size === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const parts: string[] = [];
		for (const c of consumers.values()) {
			const s = c.currentStatus;
			const label = statusLabel(s, c.bufferDepth, c.droppedCount);
			const mode = c.config.mode === "auto" ? "auto" : "pull";
			parts.push(`${c.name}[${mode}]=${label}`);
		}
		ctx.ui.setStatus(STATUS_KEY, `kafka: ${parts.join("  ")}`);
	};

	const disconnectAll = async (): Promise<void> => {
		const list = [...consumers.values()];
		consumers.clear();
		await Promise.allSettled(list.map((c) => c.disconnect()));
	};

	const onAutoMessage = (
		record: KafkaMessageRecord,
		cfg: ResolvedConsumer,
	): void => {
		const deliverAs: DeliverAs = cfg.auto.deliverAs;
		const body = `${cfg.auto.prefix}${formatRecord(record)}`;
		try {
			pi.sendUserMessage(body, { deliverAs });
		} catch (err) {
			debug("sendUserMessage failed:", err);
		}
	};

	const buildConsumers = async (
		ctx: ExtensionContext,
		result: LoadResult,
	): Promise<void> => {
		if (result.config.length === 0) {
			ctx.ui.notify(
				result.errors.length > 0
					? `kafka: ${result.errors[0]}`
					: "kafka: no consumers configured",
				"warning",
			);
			return;
		}
		for (const cfg of result.config) {
			if (consumers.has(cfg.name)) continue;
			const managed = new ManagedConsumer(cfg);
			consumers.set(cfg.name, managed);

			if (cfg.mode === "auto") {
				managed.onMessage((record) => onAutoMessage(record, cfg));
			}

			if (cfg.notify) {
				managed.onMessage((record) => {
					const summary =
						record.value.length > 80
							? `${record.value.slice(0, 77)}…`
							: record.value;
					ctx.ui.notify(
						`kafka[${cfg.name}] ${record.topic}: ${summary.replace(/\n/g, " ")}`,
						"info",
					);
				});
			}
		}

		await Promise.allSettled(
			[...consumers.values()].map((c) =>
				c.connect().catch((err) => {
					debug(`connect failed for ${c.name}:`, err);
					ctx.ui.notify(
						`kafka[${c.name}] connect failed: ${(err as Error).message}`,
						"error",
					);
				}),
			),
		);
		refreshStatus(ctx);
	};

	// ---- Lifecycle ---------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		if (DISABLED) {
			ctx.ui.notify("kafka: KAFKA_DISABLED=1, not connecting", "info");
			return;
		}
		activeLoad = await loadConfig(ctx.cwd);
		if (activeLoad.source) {
			debug(`loaded config from ${activeLoad.source}`);
		} else {
			debug("no kafka config found");
		}
		if (activeLoad.errors.length > 0) {
			for (const err of activeLoad.errors)
				ctx.ui.notify(`kafka: ${err}`, "error");
		}
		await buildConsumers(ctx, activeLoad);
	});

	pi.on("session_shutdown", async () => {
		await disconnectAll();
	});

	// ---- /kafka command family --------------------------------------------

	pi.registerCommand("kafka", {
		description: "List Kafka consumers and their status.",
		handler: async (_args, ctx) => {
			if (consumers.size === 0) {
				ctx.ui.notify("kafka: no consumers", "info");
				return;
			}
			const lines: string[] = [];
			for (const c of consumers.values()) {
				const s = c.currentStatus;
				lines.push(
					`${c.name} [${c.config.mode}] topics=${c.config.topics.join(",")} ` +
						`status=${statusLabel(s, c.bufferDepth, c.droppedCount)}`,
				);
			}
			pi.sendMessage(
				{
					customType: "kafka-status",
					content: lines.join("\n"),
					display: true,
					attribution: "agent",
				},
				{ triggerTurn: false },
			);
			ctx.ui.notify(`kafka: ${consumers.size} consumer(s)`, "info");
		},
	});

	pi.registerCommand("kafka-tail", {
		description: "Print the last N records from a Kafka consumer.",
		getArgumentCompletions: () => {
			const names = [...consumers.keys()];
			return names.map((n) => ({
				value: n,
				label: n,
				description: "consumer name",
			}));
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const name = parts[0];
			const limit = parts[1] ? Math.max(1, Number(parts[1])) : 20;
			if (!name) {
				ctx.ui.notify("usage: /kafka-tail <consumer> [limit]", "warning");
				return;
			}
			const c = consumers.get(name);
			if (!c) {
				ctx.ui.notify(`kafka: unknown consumer "${name}"`, "error");
				return;
			}
			const records = c.tail(Number.isFinite(limit) ? limit : 20);
			if (records.length === 0) {
				ctx.ui.notify(`kafka[${name}]: no buffered messages`, "info");
				return;
			}
			pi.sendMessage(
				{
					customType: "kafka-tail",
					content: records.map(formatRecord).join("\n\n"),
					display: true,
					attribution: "agent",
				},
				{ triggerTurn: false },
			);
		},
	});

	pi.registerCommand("kafka-drop", {
		description: "Clear the in-memory buffer for a Kafka consumer.",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify("usage: /kafka-drop <consumer>", "warning");
				return;
			}
			const c = consumers.get(name);
			if (!c) {
				ctx.ui.notify(`kafka: unknown consumer "${name}"`, "error");
				return;
			}
			c.clear();
			ctx.ui.notify(`kafka[${name}]: buffer cleared`, "info");
			refreshStatus(ctx);
		},
	});

	pi.registerCommand("kafka-reload", {
		description: "Disconnect and reconnect every Kafka consumer.",
		handler: async (_args, ctx) => {
			ctx.ui.notify("kafka: reloading…", "info");
			await disconnectAll();
			if (activeLoad) {
				await buildConsumers(ctx, activeLoad);
				ctx.ui.notify("kafka: reload complete", "info");
			}
		},
	});

	pi.registerCommand("kafka-pause", {
		description: "Pause a Kafka consumer (keeps buffer, no fetch).",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify("usage: /kafka-pause <consumer>", "warning");
				return;
			}
			const c = consumers.get(name);
			if (!c) {
				ctx.ui.notify(`kafka: unknown consumer "${name}"`, "error");
				return;
			}
			await c.pause();
			refreshStatus(ctx);
		},
	});

	pi.registerCommand("kafka-resume", {
		description: "Resume a paused Kafka consumer.",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify("usage: /kafka-resume <consumer>", "warning");
				return;
			}
			const c = consumers.get(name);
			if (!c) {
				ctx.ui.notify(`kafka: unknown consumer "${name}"`, "error");
				return;
			}
			await c.resume();
			refreshStatus(ctx);
		},
	});

	// ---- LLM-callable tool -------------------------------------------------
	// Build the tool definition in a typed local first, then cast it to the
	// inferred `registerTool` parameter shape. This isolates TypeScript's
	// deep zod inference inside the `toolDef` initializer and lets the
	// `registerTool` call site stay shallow.

	const toolDef = {
		name: "kafka_consume",
		label: "Kafka Consume",
		description:
			"Read buffered messages from a Kafka consumer. Use to inspect " +
			"what has been consumed in pull mode, or to recap the tail of an " +
			"auto consumer. Parameters: consumer (string, optional consumer " +
			"name from kafka.yml), limit (integer 1..500, default 20), " +
			"since (ISO 8601 timestamp, default = no filter).",
		parameters: consumeParameters,
		async execute(
			_id: string,
			params: { consumer?: string; limit?: number; since?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: ExtensionContext,
		) {
			const limit = params.limit ?? 20;
			const lines: string[] = [];
			const targets = params.consumer
				? [consumers.get(params.consumer)].filter((c): c is ManagedConsumer =>
						Boolean(c),
					)
				: [...consumers.values()];

			if (targets.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: params.consumer
								? `unknown consumer: ${params.consumer}`
								: "no consumers configured",
						},
					],
					details: { count: 0 },
				};
			}

			let total = 0;
			for (const c of targets) {
				const records = c.tail(limit, params.since);
				if (records.length === 0) {
					lines.push(`# ${c.name}: (empty)`);
					continue;
				}
				lines.push(`# ${c.name} (${records.length})`);
				for (const r of records) lines.push(formatRecord(r));
				total += records.length;
			}

			return {
				content: [{ type: "text" as const, text: lines.join("\n\n") }],
				details: { count: total },
			};
		},
	};
	// Cast through `unknown` because the deeply-recursive zod type does not
	// satisfy the `TSchema = ZodType | Type | TJsonSchema` constraint. The
	// runtime contract is documented in `description` and verified by the
	// shape of the returned tool result.
	pi.registerTool(toolDef as unknown as Parameters<typeof pi.registerTool>[0]);
}
