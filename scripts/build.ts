import { readFileSync, writeFileSync } from "node:fs";

console.log("Building Forge CLI bundle...");
const result = await Bun.build({
  entrypoints: ["apps/cli/src/index.ts"],
  outdir: "dist",
  target: "bun",
  bundle: true,
});

if (!result.success) {
  console.error("Build failed:", result.logs);
  process.exit(1);
}

const bundlePath = "dist/index.js";
let content = readFileSync(bundlePath, "utf8");
content = content.replace(/^(#![^\n]*\n)+/, "");
writeFileSync(bundlePath, `#!/usr/bin/env bun\n${content}`);

console.log("✅ Successfully built dist/index.js shebang executable");
