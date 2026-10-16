import fs from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";

/** Only the slice of the SDK client the loop uses, so a scripted fake can stand in for tests. */
export type ModelClient = {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
};

export type Tool = Anthropic.Tool & { run(input: Record<string, unknown>): Promise<string> };

export type Limits = {
  maxTurns: number; // model calls per run
  maxUsd: number; // hard spend ceiling for the run
  maxRepeats: number; // identical tool calls allowed before the run is stopped
};

export type StopReason = "done" | "max_turns" | "budget" | "loop" | "refusal" | "max_tokens";

export type RunResult = { stop: StopReason; text: string; turns: number; usd: number };

type Checkpoint = { messages: Anthropic.MessageParam[]; turns: number; usd: number; calls: Record<string, number> };

// USD per 1M tokens for claude-opus-5-5 (input, output, cache read, cache write 5m).
const PRICE = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

export function costUsd(u: Anthropic.Usage): number {
  return (
    (u.input_tokens * PRICE.input +
      u.output_tokens * PRICE.output +
      (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite) /
    1e6
  );
}

/** Same tool + same arguments => same key, whatever order the model wrote the keys in. */
export function callKey(name: string, input: unknown): string {
  const canon = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
      : v;
  return `${name}:${JSON.stringify(canon(input))}`;
}

export async function runAgent(opts: {
  client: ModelClient;
  model?: string;
  system: string;
  task: string;
  tools: Tool[];
  limits: Limits;
  checkpointPath: string; // written after every turn; an existing file is resumed
  costLogPath: string; // one JSON line per model call
}): Promise<RunResult> {
  const { client, tools, limits } = opts;
  const model = opts.model ?? "claude-opus-5-5";
  const cp: Checkpoint = fs.existsSync(opts.checkpointPath)
    ? JSON.parse(fs.readFileSync(opts.checkpointPath, "utf8"))
    : { messages: [{ role: "user", content: opts.task }], turns: 0, usd: 0, calls: {} };
  const save = () => fs.writeFileSync(opts.checkpointPath, JSON.stringify(cp));
  const end = (stop: StopReason, text = ""): RunResult => (save(), { stop, text, turns: cp.turns, usd: cp.usd });

  while (true) {
    // Guards run BEFORE spending money on the next call.
    if (cp.turns >= limits.maxTurns) return end("max_turns");
    if (cp.usd >= limits.maxUsd) return end("budget");

    const res = await client.messages.create({
      model,
      max_tokens: 16000,
      system: opts.system,
      output_config: { effort: "low" }, // simple browsing task: fewer, consolidated tool calls
      tools: tools.map(({ run: _run, ...def }) => def),
      messages: cp.messages,
    });
    cp.turns++;
    const usd = costUsd(res.usage);
    cp.usd += usd;
    fs.appendFileSync(
      opts.costLogPath,
      JSON.stringify({ turn: cp.turns, in: res.usage.input_tokens, out: res.usage.output_tokens, usd, totalUsd: cp.usd, stop: res.stop_reason }) + "\n",
    );
    // Append the full content (thinking blocks included) so the history stays valid.
    cp.messages.push({ role: "assistant", content: res.content });

    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    if (res.stop_reason === "refusal") return end("refusal", text);
    if (res.stop_reason === "max_tokens") return end("max_tokens", text);
    if (res.stop_reason !== "tool_use") return end("done", text);

    const results: Anthropic.ToolResultBlockParam[] = [];
    let looping = false;
    for (const b of res.content) {
      if (b.type !== "tool_use") continue;
      const key = callKey(b.name, b.input);
      const seen = (cp.calls[key] = (cp.calls[key] ?? 0) + 1);
      if (seen >= limits.maxRepeats) looping = true;
      const tool = tools.find((t) => t.name === b.name);
      let content: string;
      let is_error = false;
      if (seen > 1) {
        // Soft brake first: tell the model it is repeating itself instead of re-running the tool.
        content = `You already called ${b.name} with these exact arguments (${seen}x). The result has not changed. Use what you have or try something different.`;
        is_error = true;
      } else if (!tool) {
        content = `Unknown tool ${b.name}`;
        is_error = true;
      } else {
        try {
          content = await tool.run(b.input as Record<string, unknown>);
        } catch (e) {
          content = `Tool error: ${(e as Error).message}`;
          is_error = true;
        }
      }
      results.push({ type: "tool_result", tool_use_id: b.id, content, is_error });
    }
    // Every tool_result goes back in ONE user message (keeps parallel tool use working).
    cp.messages.push({ role: "user", content: results });
    save();
    if (looping) return end("loop", text); // hard stop: same call hit maxRepeats
  }
}
