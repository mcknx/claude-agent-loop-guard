import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent, callKey, type Tool, type Limits } from "../src/agent.ts";
import { fakeModel, researchScript } from "../src/fake-model.ts";
import { browserTools } from "../src/browser-tools.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loop-guard-"));
let n = 0;
const files = () => ({ checkpointPath: path.join(tmp, `cp${++n}.json`), costLogPath: path.join(tmp, `cost${n}.jsonl`) });
const limits: Limits = { maxTurns: 8, maxUsd: 1, maxRepeats: 3 };
const base = { system: "test", task: "compare backpacks" };

/** A tool that needs no browser and counts how often it really ran. */
function stubTool() {
  const t = {
    calls: 0,
    name: "visit_page",
    description: "stub",
    input_schema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] },
    async run(input: Record<string, unknown>) {
      t.calls++;
      return `page ${input.path}`;
    },
  };
  return t satisfies Tool;
}

test("happy path: real Playwright over the fixture site, scripted model", async () => {
  const { tools, close } = await browserTools("fixtures/site");
  after(close);
  const client = fakeModel(researchScript);
  const r = await runAgent({ ...base, client, tools, limits, ...files() });
  assert.equal(r.stop, "done");
  assert.equal(r.turns, 3);
  assert.match(r.text, /Best value: Ridge 35/);
  // The 3rd request carries the real scraped prices back to the model, all in one user message.
  const last = client.requests[2].messages.at(-1)!;
  const results = last.content as { content: string }[];
  assert.equal(results.length, 3);
  assert.match(results[1].content, /Price: \$129\.00/);
  // Untrusted model input cannot escape the site folder.
  await assert.rejects(tools[0].run({ path: "../../package.json" }), /outside the site/);
});

test("max turns guard stops a model that never finishes", async () => {
  const client = fakeModel((i) => ({ tools: [{ name: "visit_page", input: { path: `p${i}.html` } }] }));
  const r = await runAgent({ ...base, client, tools: [stubTool()], limits: { ...limits, maxTurns: 5 }, ...files() });
  assert.equal(r.stop, "max_turns");
  assert.equal(r.turns, 5);
  assert.equal(client.requests.length, 5, "no 6th call was paid for");
});

test("USD budget guard stops before the next call once spend hits the ceiling", async () => {
  // 100k in + 10k out on Opus 5.5 = $0.40 + $0.20 = $0.60 per call
  const client = fakeModel((i) => ({ tools: [{ name: "visit_page", input: { path: `p${i}.html` } }], usage: [100_000, 10_000] }));
  const r = await runAgent({ ...base, client, tools: [stubTool()], limits: { ...limits, maxUsd: 1 }, ...files() });
  assert.equal(r.stop, "budget");
  assert.equal(r.turns, 2);
  assert.equal(r.usd.toFixed(2), "1.20");
});

test("repeat breaker: soft warning on the 2nd identical call, hard stop on the 3rd", async () => {
  const tool = stubTool();
  // Same call each turn; key order changes on turn 2 to prove the key is canonical.
  const client = fakeModel((i) => ({ tools: [{ name: "visit_page", input: i === 1 ? { tab: 1, path: "index.html" } : { path: "index.html", tab: 1 } }] }));
  const r = await runAgent({ ...base, client, tools: [tool], limits, ...files() });
  assert.equal(r.stop, "loop");
  assert.equal(r.turns, 3);
  assert.equal(tool.calls, 1, "the tool really ran only once");
  const second = (client.requests[2].messages.at(-1)!.content as { content: string; is_error: boolean }[])[0];
  assert.equal(second.is_error, true);
  assert.match(second.content, /already called visit_page/);
  assert.equal(callKey("t", { a: 1, b: { c: 2, d: 3 } }), callKey("t", { b: { d: 3, c: 2 }, a: 1 }));
});

test("checkpoint/resume: a stopped run continues where it left off without redoing work", async () => {
  const f = files();
  const tool = stubTool();
  const first = await runAgent({ ...base, client: fakeModel(researchScript), tools: [tool], limits: { ...limits, maxTurns: 2 }, ...f });
  assert.equal(first.stop, "max_turns");
  assert.equal(tool.calls, 4); // index + 3 products

  // New process, new client: resumes from the checkpoint file, so only step 3 is left.
  const resumed = fakeModel((i) => researchScript[i + 2]);
  const second = await runAgent({ ...base, client: resumed, tools: [tool], limits, ...f });
  assert.equal(second.stop, "done");
  assert.equal(second.turns, 3);
  assert.equal(resumed.requests.length, 1);
  assert.equal(resumed.requests[0].messages.length, 5, "full history came from the checkpoint");
  assert.equal(tool.calls, 4, "no page was fetched twice");
});

test("cost log: one JSON line per model call, totals match the result", async () => {
  const f = files();
  const r = await runAgent({ ...base, client: fakeModel(researchScript), tools: [stubTool()], limits, ...f });
  const lines = fs.readFileSync(f.costLogPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, r.turns);
  assert.equal(lines.at(-1).totalUsd, r.usd);
  assert.equal(lines[0].usd, (1000 * 4 + 200 * 20) / 1e6); // default fake usage on Opus 5.5 prices
});
