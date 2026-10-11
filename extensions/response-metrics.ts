import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Footer metrics segment: `TTFT 1.2s | TPS 42.3 | Cache 87%`
 *
 * Design notes (why it behaves the way it does):
 * - Values persist. A new request never blanks the segment back to `--`; the last
 *   measured values stay on screen until replaced by fresh ones.
 * - TTFT is anchored at `before_provider_request` (immediately before the HTTP
 *   call) and refined from `turn_start` only as a fallback, so prompt building and
 *   compaction time are not counted as time-to-first-token.
 * - Providers only report real usage at the end of a response, so while streaming
 *   the token count is estimated from the received text (CJK-aware, same 3.5
 *   chars/token heuristic pi uses elsewhere) and snapped to the exact usage value
 *   on `message_end`.
 * - Cache hit rate is `cacheRead / (input + cacheRead + cacheWrite)`, matching how
 *   providers report non-cached input separately from cache reads and writes.
 */

const STATUS_KEY = "response-metrics";
/** Same chars-per-token heuristic pi uses for token estimation. */
const CHARS_PER_TOKEN = 3.5;
/** Rough token weight of a CJK character (they are ~1 token each, not 1/3.5). */
const CJK_TOKENS_PER_CHAR = 1;
/** Minimum gap between footer repaints while streaming. */
const MIN_PUBLISH_INTERVAL_MS = 120;
/** Ticker used so TTFT/TPS keep moving while waiting for the first token. */
const TICK_INTERVAL_MS = 250;
/** Too-short windows make TPS meaningless. */
const MIN_TPS_WINDOW_SECONDS = 0.2;

type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

type Snapshot = {
  ttftMs: number | null;
  tps: number | null;
  cacheRate: number | null;
};

type Live = {
  turnStartedAt: number | null;
  requestStartedAt: number | null;
  firstTokenAt: number | null;
  estimatedTokens: number;
  usage: Usage | null;
};

type AssistantLike = {
  role: "assistant";
  stopReason?: string;
  usage?: unknown;
};

function now(): number {
  return performance.now();
}

function createLive(): Live {
  return {
    turnStartedAt: null,
    requestStartedAt: null,
    firstTokenAt: null,
    estimatedTokens: 0,
    usage: null,
  };
}

function createSnapshot(): Snapshot {
  return { ttftMs: null, tps: null, cacheRate: null };
}

function isAssistantMessage(message: unknown): message is AssistantLike {
  return typeof message === "object" && message !== null && (message as { role?: unknown }).role === "assistant";
}

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function readUsage(raw: unknown): Usage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const usage: Usage = {
    input: positiveNumber(record.input),
    output: positiveNumber(record.output),
    cacheRead: positiveNumber(record.cacheRead),
    cacheWrite: positiveNumber(record.cacheWrite),
  };
  if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) return null;
  return usage;
}

function cacheRateOf(usage: Usage): number | null {
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (promptTokens <= 0) return null;
  return (usage.cacheRead / promptTokens) * 100;
}

function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) // Hangul Jamo
    || (codePoint >= 0x2e80 && codePoint <= 0x303f) // CJK radicals and punctuation
    || (codePoint >= 0x3040 && codePoint <= 0x30ff) // Kana
    || (codePoint >= 0x3400 && codePoint <= 0x4dbf) // CJK extension A
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff) // CJK unified ideographs
    || (codePoint >= 0xac00 && codePoint <= 0xd7af) // Hangul syllables
    || (codePoint >= 0xf900 && codePoint <= 0xfaff) // CJK compatibility ideographs
    || (codePoint >= 0xfe30 && codePoint <= 0xfe4f) // CJK compatibility forms
    || (codePoint >= 0xff00 && codePoint <= 0xffef) // Fullwidth forms
    || (codePoint >= 0x20000 && codePoint <= 0x3ffff) // CJK extension B and beyond
  );
}

function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined && isCjkCodePoint(codePoint)) cjk += 1;
    else other += 1;
  }
  return cjk * CJK_TOKENS_PER_CHAR + other / CHARS_PER_TOKEN;
}

function formatDuration(milliseconds: number): string {
  const safe = Math.max(0, milliseconds);
  if (safe < 1000) return `${Math.round(safe)}ms`;
  return `${(safe / 1000).toFixed(1)}s`;
}

function formatRate(tokensPerSecond: number | null): string {
  if (tokensPerSecond === null || !Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return "--";
  return tokensPerSecond >= 100 ? Math.round(tokensPerSecond).toString() : tokensPerSecond.toFixed(1);
}

export default function responseMetricsExtension(pi: ExtensionAPI) {
  let live: Live = createLive();
  let snapshot: Snapshot = createSnapshot();
  let currentCtx: ExtensionContext | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let lastPublishedAt = 0;
  let lastPublishedText: string | null = null;

  function stopTicker(): void {
    if (ticker === null) return;
    clearInterval(ticker);
    ticker = null;
  }

  function startTicker(ctx: ExtensionContext): void {
    currentCtx = ctx;
    if (ticker !== null) return;
    ticker = setInterval(() => {
      if (currentCtx) publish(currentCtx);
    }, TICK_INTERVAL_MS);
    (ticker as unknown as { unref?: () => void }).unref?.();
  }

  function renderText(at: number): string {
    const anchor = live.requestStartedAt ?? live.turnStartedAt;
    let ttftText: string;
    if (live.firstTokenAt !== null && live.requestStartedAt !== null) {
      ttftText = formatDuration(live.firstTokenAt - live.requestStartedAt);
    } else if (anchor !== null) {
      // Request is in flight and no token has arrived yet: show it counting up.
      ttftText = `${formatDuration(at - anchor)}\u2026`;
    } else if (snapshot.ttftMs !== null) {
      ttftText = formatDuration(snapshot.ttftMs);
    } else {
      ttftText = "--";
    }

    let tps: number | null = null;
    if (live.firstTokenAt !== null) {
      const seconds = (at - live.firstTokenAt) / 1000;
      const tokens = live.usage && live.usage.output > 0 ? live.usage.output : live.estimatedTokens;
      if (seconds >= MIN_TPS_WINDOW_SECONDS && tokens > 0) tps = tokens / seconds;
    }
    // Never fall back to a placeholder once a value has been measured: before the
    // first token of a new request, keep showing the previous request's rate.
    if (tps === null) tps = snapshot.tps;

    const liveCacheRate = live.usage ? cacheRateOf(live.usage) : null;
    const cacheRate = liveCacheRate ?? snapshot.cacheRate;
    const cacheText = cacheRate === null ? "--" : `${Math.round(cacheRate)}%`;

    return `TTFT ${ttftText} | TPS ${formatRate(tps)} | Cache ${cacheText}`;
  }

  function publish(ctx: ExtensionContext | null, options: { force?: boolean } = {}): void {
    if (!ctx || !ctx.hasUI) return;
    try {
      const at = now();
      const text = renderText(at);
      if (text === lastPublishedText) return;
      if (!options.force && at - lastPublishedAt < MIN_PUBLISH_INTERVAL_MS) return;
      lastPublishedAt = at;
      lastPublishedText = text;
      ctx.ui.setStatus(STATUS_KEY, text);
    } catch {
      // A stale/invalidated extension context must never break the session.
    }
  }

  /** Resume case: keep the previous cache hit rate visible instead of showing `--`. */
  function seedSnapshotFromSession(ctx: ExtensionContext): Snapshot {
    const seeded = createSnapshot();
    try {
      const branch = ctx.sessionManager.getBranch();
      for (let index = branch.length - 1; index >= 0; index -= 1) {
        const entry = branch[index] as { type?: string; message?: unknown } | undefined;
        if (entry?.type !== "message" || !isAssistantMessage(entry.message)) continue;
        const usage = readUsage(entry.message.usage);
        if (!usage) continue;
        seeded.cacheRate = cacheRateOf(usage);
        break;
      }
    } catch {
      // Ignore: seeding is best-effort.
    }
    return seeded;
  }

  pi.on("session_start", async (_event, ctx) => {
    stopTicker();
    live = createLive();
    snapshot = seedSnapshotFromSession(ctx);
    lastPublishedText = null;
    lastPublishedAt = 0;
    publish(ctx, { force: true });
  });

  pi.on("session_shutdown", async () => {
    stopTicker();
    currentCtx = null;
  });

  pi.on("turn_start", async (_event, ctx) => {
    // A new model request is about to be built; reset the measurement window but
    // keep the previously measured values on screen.
    live = createLive();
    live.turnStartedAt = now();
    live.requestStartedAt = live.turnStartedAt;
    startTicker(ctx);
    publish(ctx, { force: true });
  });

  pi.on("before_provider_request", async (_event, ctx) => {
    currentCtx = ctx;
    // Ignore work that is not part of an active turn (idle prompt-cache warming,
    // compaction and similar background model calls).
    if (live.turnStartedAt === null || live.firstTokenAt !== null) return;
    live.requestStartedAt = now();
  });

  pi.on("message_start", async (event, ctx) => {
    currentCtx = ctx;
    if (!isAssistantMessage(event.message)) return;
    // Fallback anchor in case turn_start was not observed.
    if (live.turnStartedAt === null && live.requestStartedAt === null) {
      live.turnStartedAt = now();
      live.requestStartedAt = live.turnStartedAt;
      startTicker(ctx);
    }
  });

  pi.on("message_update", async (event, ctx) => {
    if (!isAssistantMessage(event.message)) return;
    currentCtx = ctx;

    const kind = event.assistantMessageEvent?.type;
    if (kind === "text_delta" || kind === "thinking_delta" || kind === "toolcall_delta") {
      if (live.turnStartedAt === null && live.requestStartedAt === null) {
        live.turnStartedAt = now();
        live.requestStartedAt = live.turnStartedAt;
      }
      if (live.firstTokenAt === null) live.firstTokenAt = now();
      const delta = (event.assistantMessageEvent as { delta?: unknown }).delta;
      if (typeof delta === "string" && delta.length > 0) {
        live.estimatedTokens += estimateTokens(delta);
      }
    }

    const usage = readUsage(event.message.usage);
    if (usage) live.usage = usage;
    publish(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    if (!isAssistantMessage(event.message)) return;
    currentCtx = ctx;

    const failed = event.message.stopReason === "error" || event.message.stopReason === "aborted";
    if (!failed) {
      const endedAt = now();
      const usage = readUsage(event.message.usage);
      const next: Snapshot = { ...snapshot };

      if (live.firstTokenAt !== null && live.requestStartedAt !== null) {
        next.ttftMs = live.firstTokenAt - live.requestStartedAt;
      }

      if (live.firstTokenAt !== null) {
        const seconds = (endedAt - live.firstTokenAt) / 1000;
        const tokens = usage && usage.output > 0 ? usage.output : live.estimatedTokens;
        if (seconds >= MIN_TPS_WINDOW_SECONDS && tokens > 0) next.tps = tokens / seconds;
      }

      const cacheRate = usage ? cacheRateOf(usage) : live.usage ? cacheRateOf(live.usage) : null;
      if (cacheRate !== null) next.cacheRate = cacheRate;

      snapshot = next;
    }

    live = createLive();
    stopTicker();
    publish(ctx, { force: true });
  });

  const endWindow = async (_event: unknown, ctx: ExtensionContext) => {
    currentCtx = ctx;
    if (live.turnStartedAt !== null || live.requestStartedAt !== null) {
      live = createLive();
      stopTicker();
    }
  };

  // Safety net when a turn ends without an assistant message_end (abort, errors).
  pi.on("turn_end", endWindow);
  pi.on("agent_end", endWindow);
}
