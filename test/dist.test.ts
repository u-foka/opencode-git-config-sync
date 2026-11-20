import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// opencode maps these to its own copies; anything else imported by name would load a second copy (or fail).
const HOST = ["solid-js", "@opentui/solid", "@opentui/core", "@opencode/plugin/tui"]
const BUILTINS = ["child_process", "fs", "fs/promises", "os", "path"]

test("dist/tui.js is up to date with src", () => {
  const out = mkdtempSync(join(tmpdir(), "config-sync-build-"))
  try {
    execFileSync("bun", ["scripts/build.ts", out], { stdio: "pipe" })
    expect(readFileSync("dist/tui.js", "utf8")).toBe(readFileSync(join(out, "tui.js"), "utf8"))
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test("dist/tui.js imports only host modules and node built-ins, with the JSX compiled", () => {
  const code = readFileSync("dist/tui.js", "utf8")
  const imports = [...code.matchAll(/^import[^;]*?from\s*"([^"]+)"/gm)].map((match) => match[1])
  expect(imports.length).toBeGreaterThan(0)
  for (const name of imports) expect([...HOST, ...BUILTINS, ...BUILTINS.map((path) => `node:${path}`)]).toContain(name)
  expect(code).not.toContain("jsx-runtime")
  expect(code).not.toContain("jsxDEV")
})
