/**
 * Offline smoke tests for the response-metrics extension.
 *
 * The extension is driven through a fake `pi` event bus, so these tests need no
 * model, no provider and no network. Run them with `npm test`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import responseMetricsExtension from "../extensions/response-metrics.ts";

const STATUS_KEY = "response-metrics";

type Usage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

type AssistantMessage = {
  role: "assistant";
  stopReason?: string;
  usage?: Usage;
};

type Handler = (event: any, ctx: any) => unknown;

type HarnessOptions = {
  /** Entries returned by `sessionManager.getBranch()`, used for resume seeding. */
  branch?: unknown[];
};

function assistant(usage?: Usage, stopReason = "end_turn"): AssistantMessage {
  return usage ? { role: "assistant", stopReason, usage } : { role: "assistant", stopReason };
}

function delta(text: string) {
  return { assistantMessageEvent: { type: "text_delta", delta: text } };
}

function createHarness(options: HarnessOptions = {}) {
  const handlers = new Map<string, Handler>();
  const statuses = new Map<string, string>();

  const ctx = {
    hasUI: true,
    ui: {
      setStatus(key: string, text: string): void {
        statuses.set(key, text);
      },
    },
    sessionManager: {
      getBranch: (): unknown[] => options.branch ?? [],
    },
  };

  // The extension only needs `on`; every registration is recorded by event name.
  responseMetricsExtension({
    on(event: string, handler: Handler): void {
      handlers.set(event, handler);
    },
  } as never);

  async function emit(event: string, payload: Record<string, unknown> = {}): Promise<void> {
    const handler = handlers.get(event);
    assert.ok(handler, `extension did not register a handler for "${event}"`);
    await handler({ type: event, ...payload }, ctx);
  }

  return {
    emit,
    ctx,
    statusText: (): string => statuses.get(STATUS_KEY) ?? "",
    registeredEvents: (): string[] => [...handlers.keys()],
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const METRICS_PATTERN = /^TTFT \S+ \| TPS \S+ \| Cache \S+$/;

test("registers handlers for the whole turn lifecycle", () => {
  const harness = createHarness();
  for (const event of [
    "session_start",
    "session_shutdown",
    "turn_start",
    "before_provider_request",
    "message_start",
    "message_update",
    "message_end",
    "turn_end",
    "agent_end",
  ]) {
    assert.ok(harness.registeredEvents().includes(event), `missing handler: ${event}`);
  }
});

test("renders TTFT, TPS and cache rate after a normal turn", async () => {
  const harness = createHarness();

  await harness.emit("session_start");
  assert.equal(harness.statusText(), "TTFT -- | TPS -- | Cache --");

  await harness.emit("turn_start");
  await harness.emit("before_provider_request");
  await harness.emit("message_start", { message: assistant() });
  await harness.emit("message_update", { message: assistant(), ...delta("Hello world") });
  await sleep(260);
  await harness.emit("message_end", {
    message: assistant({ input: 100, output: 200, cacheRead: 900, cacheWrite: 0 }),
  });

  const text = harness.statusText();
  assert.match(text, METRICS_PATTERN);
  assert.match(text, /^TTFT \d+ms \| TPS \d+(\.\d)? \| Cache 90%$/);
  await harness.emit("session_shutdown");
});

test("cache hit rate is cacheRead over total prompt tokens", async () => {
  const harness = createHarness();

  await harness.emit("session_start");
  await harness.emit("turn_start");
  await harness.emit("before_provider_request");
  await harness.emit("message_update", { message: assistant(), ...delta("ok") });
  await harness.emit("message_end", {
    // 475 / (25 + 475 + 0) = 95%
    message: assistant({ input: 25, output: 5, cacheRead: 475, cacheWrite: 0 }),
  });

  assert.match(harness.statusText(), /Cache 95%/);
  await harness.emit("session_shutdown");
});

test("cache writes count against the hit rate", async () => {
  const harness = createHarness();

  await harness.emit("session_start");
  await harness.emit("turn_start");
  await harness.emit("before_provider_request");
  await harness.emit("message_update", { message: assistant(), ...delta("ok") });
  await harness.emit("message_end", {
    // 500 / (0 + 500 + 500) = 50%
    message: assistant({ input: 0, output: 5, cacheRead: 500, cacheWrite: 500 }),
  });

  assert.match(harness.statusText(), /Cache 50%/);
  await harness.emit("session_shutdown");
});

test("an aborted turn keeps the previously measured values on screen", async () => {
  const harness = createHarness();

  await harness.emit("session_start");
  await harness.emit("turn_start");
  await harness.emit("before_provider_request");
  await harness.emit("message_update", { message: assistant(), ...delta("first answer") });
  await harness.emit("message_end", {
    message: assistant({ input: 100, output: 10, cacheRead: 900, cacheWrite: 0 }),
  });
  assert.match(harness.statusText(), /Cache 90%/);

  // Second turn is aborted: nothing may be overwritten, not even back to "--".
  await harness.emit("turn_start");
  await harness.emit("before_provider_request");
  await harness.emit("message_update", { message: assistant(), ...delta("partial") });
  await harness.emit("message_end", {
    message: assistant({ input: 10, output: 1, cacheRead: 0, cacheWrite: 0 }, "aborted"),
  });

  const text = harness.statusText();
  assert.match(text, METRICS_PATTERN);
  assert.match(text, /Cache 90%/);
  assert.doesNotMatch(text, /Cache --/);
  await harness.emit("session_shutdown");
});

test("a failed turn does not blank the metrics", async () => {
  const harness = createHarness();

  await harness.emit("session_start");
  await harness.emit("turn_start");
  await harness.emit("before_provider_request");
  await harness.emit("message_update", { message: assistant(), ...delta("first answer") });
  await harness.emit("message_end", {
    message: assistant({ input: 100, output: 10, cacheRead: 100, cacheWrite: 0 }),
  });
  assert.match(harness.statusText(), /Cache 50%/);

  await harness.emit("turn_start");
  await harness.emit("message_end", { message: assistant(undefined, "error") });

  assert.match(harness.statusText(), /Cache 50%/);
  await harness.emit("session_shutdown");
});

test("resuming a session seeds the cache rate from the previous branch", async () => {
  const harness = createHarness({
    branch: [
      { type: "message", message: { role: "user" } },
      { type: "message", message: assistant({ input: 200, output: 20, cacheRead: 300, cacheWrite: 0 }) },
    ],
  });

  await harness.emit("session_start");

  // 300 / 500 = 60%, visible before any new request has completed.
  assert.equal(harness.statusText(), "TTFT -- | TPS -- | Cache 60%");
  await harness.emit("session_shutdown");
});

test("TTFT counts up while the first token has not arrived", async () => {
  const harness = createHarness();

  await harness.emit("session_start");
  await harness.emit("turn_start");
  await harness.emit("before_provider_request");
  await sleep(600);

  const text = harness.statusText();
  assert.match(text, /^TTFT \d+ms\u2026 \| TPS -- \| Cache --$/);
  const elapsed = Number.parseInt(text.slice(5, text.indexOf("ms")), 10);
  assert.ok(elapsed >= 250, `expected a ticking TTFT, got ${text}`);
  await harness.emit("session_shutdown");
});

test("streams an estimated TPS when the provider reports no usage", async () => {
  const harness = createHarness();

  await harness.emit("session_start");
  await harness.emit("turn_start");
  await harness.emit("before_provider_request");
  await harness.emit("message_update", {
    message: assistant(),
    ...delta("这是一段中文回复，用于验证流式 token 估算。".repeat(4)),
  });
  await sleep(260);
  await harness.emit("message_end", { message: assistant() });

  const text = harness.statusText();
  assert.match(text, METRICS_PATTERN);
  assert.match(text, /TPS \d+(\.\d+)? \| Cache --$/);
  assert.doesNotMatch(text, /TPS --/);
  await harness.emit("session_shutdown");
});

test("an idle provider request outside a turn does not anchor TTFT", async () => {
  const harness = createHarness();

  await harness.emit("session_start");
  // Idle prompt-cache warming / compaction path: a provider call with no turn.
  await harness.emit("before_provider_request");
  await sleep(600);
  await harness.emit("turn_start");

  const text = harness.statusText();
  assert.match(text, /^TTFT \d+ms\u2026 \| TPS -- \| Cache --$/);
  const elapsed = Number.parseInt(text.slice(5, text.indexOf("ms")), 10);
  assert.ok(elapsed < 250, `the idle request must not count toward TTFT, got ${text}`);
  await harness.emit("session_shutdown");
});
