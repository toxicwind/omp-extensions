import { describe, it, expect } from "bun:test";
import { Kafka } from "kafkajs";
import { ManagedConsumer } from "../src/consumer.ts";
import type { ResolvedConsumer } from "../src/types.ts";

const makeCfg = (overrides?: Partial<ResolvedConsumer>): ResolvedConsumer => ({
	name: "test",
	mode: "pull",
	brokers: ["localhost:9092"],
	clientId: "omp-kafka-test",
	groupId: "omp-kafka-test",
	topics: ["test-topic"],
	fromBeginning: false,
	notify: true,
	maxQueue: 200,
	auto: { deliverAs: "steer", prefix: "[kafka:test] " },
	ssl: false,
	clientConfig: {},
	...overrides,
});

describe("ManagedConsumer", () => {
	it("creates a consumer with idle status and empty buffer", () => {
		const mc = new ManagedConsumer(makeCfg());
		expect(mc.name).toBe("test");
		expect(mc.currentStatus.state).toBe("idle");
		expect(mc.bufferDepth).toBe(0);
		expect(mc.droppedCount).toBe(0);
	});

	it("tail returns empty when buffer is empty", () => {
		const mc = new ManagedConsumer(makeCfg());
		expect(mc.tail(10)).toEqual([]);
	});

	it("onMessage registers and returns an unsubscribe function", () => {
		const mc = new ManagedConsumer(makeCfg());
		const records: any[] = [];
		const unsub = mc.onMessage((r) => records.push(r));
		expect(typeof unsub).toBe("function");
		unsub();
	});
});

describe("KafkaJS import", () => {
	it("Kafka class is exported from kafkajs", () => {
		expect(Kafka).toBeDefined();
		expect(typeof Kafka).toBe("function");
	});

	it("can instantiate Kafka without connecting to a broker", () => {
		const kafka = new Kafka({ clientId: "test", brokers: ["localhost:9092"], logLevel: 0 });
		expect(kafka).toBeDefined();
		expect(typeof kafka.producer).toBe("function");
		expect(typeof kafka.consumer).toBe("function");
	});
});
