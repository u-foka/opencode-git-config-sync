// Compiles the TUI plugin to plain ESM in dist/. opencode only runs its Solid JSX transform on plugin files outside
// node_modules (anomalyco/opencode#39986), so a published .tsx would load its own solid-js and never repaint. The
// compiled file imports solid-js and @opentui/* by name, and opencode maps those to its own copies.
// dist/ is committed, so the plugin also loads from a git checkout (a submodule) without a build step.
// Usage: bun scripts/build.ts [outdir]
import { rm } from "node:fs/promises"
import solid from "@opentui/solid/bun-plugin"

const outdir = process.argv[2] ?? "dist"
await rm(outdir, { recursive: true, force: true })
const result = await Bun.build({
  entrypoints: ["src/tui.tsx"],
  outdir,
  target: "bun",
  format: "esm",
  packages: "external",
  plugins: [solid],
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
