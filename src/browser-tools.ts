import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser } from "playwright";
import type { Tool } from "./agent.ts";

/** One Playwright tool: open a page of the local fixture site and return its text and links. */
export async function browserTools(siteRoot: string): Promise<{ tools: Tool[]; close(): Promise<void> }> {
  const root = path.resolve(siteRoot);
  const browser: Browser = await chromium.launch();
  const page = await browser.newPage();
  const visit: Tool = {
    name: "visit_page",
    description: "Open a page of the shop by its path (e.g. 'index.html' or 'products/x.html'). Returns the page title, visible text and links.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to the shop root" } },
      required: ["path"],
      additionalProperties: false,
    },
    async run({ path: rel }) {
      const file = path.resolve(root, String(rel));
      // The model's input is untrusted: never let it read outside the site folder.
      if (file !== root && !file.startsWith(root + path.sep)) throw new Error("path is outside the site");
      await page.goto(pathToFileURL(file).href);
      const links = await page.$$eval("a", (as) => as.map((a) => `${a.textContent?.trim()} -> ${a.getAttribute("href")}`));
      const text = (await page.innerText("body")).slice(0, 2000);
      return `Title: ${await page.title()}\n\n${text}\n\nLinks:\n${links.join("\n")}`;
    },
  };
  return { tools: [visit], close: () => browser.close() };
}
