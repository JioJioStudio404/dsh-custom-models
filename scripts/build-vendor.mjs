#!/usr/bin/env node
// Rebuild lib/vendor/pi-ai.mjs: the three wire protocols DeepSeek Harness's own custom gateway
// (@deepseek-ai/dsh-llm-pi-ai) serves — OpenAI Chat Completions, OpenAI Responses and Anthropic
// Messages — from the same @earendil-works/pi-ai release DSH ships, with the patch DSH applies
// to it (scripts/pi-ai-1.1.0-dsh.patch, from deepseek-harness tag dsh-v0.2.1-rc.3: no O(n²)
// re-parse of streamed tool arguments), bundled into one file with the vendors' SDKs they use.
//
//   node scripts/build-vendor.mjs [work-dir]
//
// Needs network access (npm) and git (to apply the patch). Review the diff before committing.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PI_AI = "1.1.0";
const ESBUILD = "0.25.10";
const root = fileURLToPath(new URL("..", import.meta.url));
const work = process.argv[2] ?? mkdtempSync(join(tmpdir(), "custom-models-vendor-"));
// npm is a .cmd script on Windows (a shell is needed); node and git are run directly (paths may hold spaces).
const run = (command, args, cwd = work) => execFileSync(command, args, { cwd, stdio: "inherit", shell: command === "npm" && process.platform === "win32" });

mkdirSync(work, { recursive: true });
writeFileSync(join(work, "package.json"), JSON.stringify({ name: "custom-models-vendor", private: true, type: "module" }));
run("npm", ["install", "--no-audit", "--no-fund", `@earendil-works/pi-ai@${PI_AI}`, `esbuild@${ESBUILD}`]);
const patch = join(root, "scripts", "pi-ai-1.1.0-dsh.patch");
const piDir = join(work, "node_modules", "@earendil-works", "pi-ai");
let patched = false;
try {
  // Already applied (a re-run in the same work dir): the reverse applies cleanly.
  execFileSync("git", ["apply", "-p1", "--reverse", "--check", patch], { cwd: piDir, stdio: "ignore" });
  patched = true;
} catch {
  /* not applied yet */
}
if (!patched) run("git", ["apply", "-p1", patch], piDir);
writeFileSync(join(work, "entry.mjs"), [
  'export { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";',
  'export { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";',
  'export { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";',
  'export { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";',
  // What pi-ai's Models.streamSimple does before a provider sees the context (system prompt and tools into the transcript).
  'export { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";',
  "",
].join("\n"));
const out = join(root, "lib", "vendor", "pi-ai.mjs");
run(process.execPath, [join(work, "node_modules", "esbuild", "bin", "esbuild"), "entry.mjs", "--bundle", "--platform=node", "--format=esm", "--target=node20", `--outfile=${out}`, "--legal-comments=eof",
  `--banner:js=// @earendil-works/pi-ai ${PI_AI} (patched as DeepSeek Harness ships it) with the OpenAI and Anthropic SDKs; built by scripts/build-vendor.mjs. Licenses: LICENSES.txt.\nimport { createRequire as __piCreateRequire } from "node:module"; const require = __piCreateRequire(import.meta.url);`]);

// Every bundled package's license, verbatim.
const bundled = ["@earendil-works/pi-ai", "openai", "@anthropic-ai/sdk", "partial-json", "standardwebhooks", "@stablelib/base64", "fast-sha256"];
const notices = bundled.map((name) => {
  const dir = join(work, "node_modules", ...name.split("/"));
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  let text = "";
  for (const file of ["LICENSE", "LICENSE.md", "LICENSE.txt", "license"]) {
    try {
      text = readFileSync(join(dir, file), "utf8").trim();
      break;
    } catch {
      /* next name */
    }
  }
  return `${pkg.name} ${pkg.version} — ${pkg.license}\n${"-".repeat(60)}\n${text || `(${pkg.license}; no license file in the package)`}\n`;
});
writeFileSync(join(root, "lib", "vendor", "LICENSES.txt"), `Third-party code bundled in pi-ai.mjs\n\n${notices.join("\n")}`);
console.log(`wrote ${out} and LICENSES.txt`);
