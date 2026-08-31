/**
 * Type definitions for omp-kafka.
 *
 * Kept separate from runtime code so a downstream test or embedder can
 * consume the config without pulling in KafkaJS or the omp runtime types.
 */

export type ConsumerMode = "auto" | "pull";

/** `sendUserMessage` delivery modes the omp runtime accepts. */
export type DeliverAs = "steer" | "followUp";

export interface AutoBlock {
	/** `sendUserMessage` delivery mode. Default: "steer". */
	deliverAs?: DeliverAs;
	/** Prefix prepended to every delivered message. Default: `[kafka:<name>] `. */
	prefix?: string;
}

export interface ConsumerConfig {
	/** Stable identifier used for tool selects and `/kafka <name> ...` commands. */
	name: string;
	/** "auto" = push consumed messages into the session; "pull" = buffer only. */
	mode: ConsumerMode;
	/** KafkaJS broker list, e.g. ["localhost:9092"]. */
	brokers: string[];
	/** Kafka client id. Default: "omp-kafka". */
	clientId?: string;
	/** Consumer group id. Default: "omp-kafka-<name>". */
	groupId?: string;
	/** Topics to subscribe to. */
	topics: string[];
	/** Map to KafkaJS `fromBeginning` (offset reset). Default: false. */
	fromBeginning?: boolean;
	/** Show a TUI notification per consumed message. Default: true. */
	notify?: boolean;
	/** In-memory ring buffer cap (oldest dropped). Default: 200. */
	maxQueue?: number;
	/** Auto-mode knobs (only honored when mode === "auto"). */
	auto?: AutoBlock;
	/** Optional SASL config. */
	sasl?: {
		mechanism: "plain" | "scram-sha-256" | "scram-sha-512";
		username: string;
		password: string;
	};
	/** Optional SSL toggle (TLS material read from env / default locations). */
	ssl?: boolean;
	/** Extra KafkaJS client options. Used by advanced users; opaque to us. */
	clientConfig?: Record<string, unknown>;
}

export interface KafkaYamlConfig {
	consumers: ConsumerConfig[];
}

/** Normalized/resolved consumer config (defaults applied, name unique). */
export interface ResolvedConsumer {
	name: string;
	mode: ConsumerMode;
	brokers: string[];
	clientId: string;
	groupId: string;
	topics: string[];
	fromBeginning: boolean;
	notify: boolean;
	maxQueue: number;
	auto: Required<AutoBlock>;
	sasl?: ConsumerConfig["sasl"];
	ssl: boolean;
	clientConfig: Record<string, unknown>;
}

/** A single consumed Kafka record (decoded text). */
export interface KafkaMessageRecord {
	consumer: string;
	topic: string;
	partition: number;
	offset: string;
	key: string | null;
	value: string;
	headers: Record<string, string>;
	timestamp: string;
}
