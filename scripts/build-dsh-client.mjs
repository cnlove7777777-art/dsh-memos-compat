/**
 * Build the browser half of the MemOS DSH plugin.
 *
 * The DSH client module loader executes package bundles as lazy CJS factories.
 * React and every @deepseek-ai package stay external so the page's native module
 * table supplies the same React instance and SDK services as the built-in UI.
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const entry = join(root, "adapters", "deepseek-harness", "client", "index.tsx");
const outfile = join(root, "dist", "adapters", "deepseek-harness", "client.js");
const moduleId = "@memtensor/memos-local-plugin";

mkdirSync(dirname(outfile), { recursive: true });
rmSync(outfile, { force: true });
rmSync(`${outfile}.map`, { force: true });

await build({
  absWorkingDir: root,
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: ["es2022"],
  jsx: "automatic",
  sourcemap: true,
  legalComments: "none",
  external: ["react", "react/*", "@deepseek-ai/*"],
  banner: {
    js: [
      "window.__ModuleLoader__.load({",
      `  id: ${JSON.stringify(moduleId)},`,
      "  factory: (require) => {",
      "    var module = { exports: {} };",
      "    var exports = module.exports;",
    ].join("\n"),
  },
  footer: {
    js: [
      "return module.exports;",
      "  }",
      "});",
    ].join("\n"),
  },
  logLevel: "info",
});

const output = readFileSync(outfile, "utf8");
for (const marker of [
  "window.__ModuleLoader__.load",
  `id: ${JSON.stringify(moduleId)}`,
  'require("react")',
  'require("react/jsx-runtime")',
  'name: "settings.section"',
  'id: "memos-memory"',
]) {
  if (!output.includes(marker)) {
    throw new Error(`built client is missing expected marker: ${marker}`);
  }
}

console.log(`built ${outfile}`);
