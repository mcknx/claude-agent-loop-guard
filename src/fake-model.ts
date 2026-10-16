import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient } from "./agent.ts";

type Step = { tools?: { name: string; input: Record<string, unknown> }[]; text?: string; usage?: [number, number] };

/**
 * A scripted stand-in for the Anthropic client: returns one canned response per call.
 * Used when no ANTHROPIC_API_KEY is set, and by every test. It records the requests it got.
 */
export function fakeModel(script: Step[] | ((turn: number) => Step)): ModelClient & { requests: Anthropic.MessageCreateParamsNonStreaming[] } {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    requests,
    messages: {
      async create(params) {
        requests.push(structuredClone(params));
        const n = requests.length - 1;
        const step = typeof script === "function" ? script(n) : script[n];
        if (!step) throw new Error(`fake model has no step ${n}`);
        const content: Anthropic.ContentBlock[] = [];
        if (step.text) content.push({ type: "text", text: step.text, citations: null } as Anthropic.TextBlock);
        step.tools?.forEach((t, i) => content.push({ type: "tool_use", id: `toolu_${n}_${i}`, name: t.name, input: t.input } as Anthropic.ToolUseBlock));
        const [input_tokens, output_tokens] = step.usage ?? [1000, 200];
        return {
          id: `msg_fake_${n}`,
          type: "message",
          role: "assistant",
          model: params.model,
          content,
          stop_reason: step.tools?.length ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens, output_tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        } as unknown as Anthropic.Message;
      },
    },
  };
}

/** The happy path a real model takes on the demo task: index, three products, then the report. */
export const researchScript: Step[] = [
  { tools: [{ name: "visit_page", input: { path: "index.html" } }] },
  {
    tools: [
      { name: "visit_page", input: { path: "products/ridge-35.html" } },
      { name: "visit_page", input: { path: "products/summit-40.html" } },
      { name: "visit_page", input: { path: "products/daylite-20.html" } },
    ],
  },
  {
    text:
      "| Product | Price | Weight | Rating |\n|---|---|---|---|\n| Summit 40 | $129.00 | 1.4 kg | 4.8 |\n| Ridge 35 | $89.00 | 1.1 kg | 4.6 |\n| Daylite 20 | $49.00 | 0.6 kg | 4.1 |\n\nBest value: Ridge 35 (4.6 rating at $89).",
  },
];
