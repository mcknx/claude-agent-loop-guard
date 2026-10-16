import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { runAgent, type ModelClient } from "./agent.ts";
import { browserTools } from "./browser-tools.ts";
import { fakeModel, researchScript } from "./fake-model.ts";

const out = path.resolve("runs");
fs.mkdirSync(out, { recursive: true });
const live = !!process.env.ANTHROPIC_API_KEY;
const client: ModelClient = live ? new Anthropic() : fakeModel(researchScript);
console.log(live ? "Model: claude-opus-5-5 (live API)" : "Model: scripted fake (no ANTHROPIC_API_KEY set)");

const { tools, close } = await browserTools("fixtures/site");
try {
  const result = await runAgent({
    client,
    system: "You research products on a small shop website using the visit_page tool. Start at index.html. Visit each product once. Finish with a markdown table (product, price, weight, rating) and one line naming the best value.",
    task: "Compare every backpack in the shop and tell me which one is the best value.",
    tools,
    limits: { maxTurns: 8, maxUsd: 0.5, maxRepeats: 3 },
    checkpointPath: path.join(out, "checkpoint.json"),
    costLogPath: path.join(out, "cost-log.jsonl"),
  });
  console.log(`\nstop=${result.stop} turns=${result.turns} usd=$${result.usd.toFixed(4)}\n\n${result.text}`);
  if (result.stop === "done") fs.rmSync(path.join(out, "checkpoint.json")); // finished runs don't resume
} finally {
  await close();
}
