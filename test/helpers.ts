import { afterAll, beforeAll } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Scratch repositories under a temp folder, with an isolated git config (identity, master as default branch, and
// local file:// submodules allowed).
export const DAY_MS = 24 * 60 * 60 * 1000
let root = ""
let counter = 0

export const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" })
export const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
}
export const fresh = (name: string) => {
  const dir = join(root, `${++counter}-${name}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A bare remote, plus a clone of it that has one pushed commit. */
export function syncedRepo(files: Record<string, string> = { "cli.json": "{}\n" }) {
  const dir = fresh("repo")
  const remote = join(dir, "remote.git")
  const repo = join(dir, "config")
  run(dir, "init", "-q", "--bare", remote)
  run(dir, "clone", "-q", remote, repo)
  for (const [path, text] of Object.entries(files)) write(join(repo, path), text)
  run(repo, "add", "-A")
  run(repo, "commit", "-qm", "initial")
  run(repo, "push", "-q", "-u", "origin", "HEAD")
  return { dir, remote, repo }
}

/** A second clone of the same remote, standing in for another machine. */
export function otherMachine(dir: string, remote: string) {
  const other = join(dir, `other-${++counter}`)
  run(dir, "clone", "-q", "--recurse-submodules", remote, other)
  return other
}

/** A published plugin repo, added to `repo` as a submodule at `plugins/x`. */
export function withSubmodule(dir: string, repo: string) {
  const subRemote = join(dir, "sub.git")
  const seed = join(dir, "sub-seed")
  run(dir, "init", "-q", "--bare", subRemote)
  run(dir, "clone", "-q", subRemote, seed)
  write(join(seed, "index.ts"), "export {}\n")
  run(seed, "add", "-A")
  run(seed, "commit", "-qm", "sub initial")
  run(seed, "push", "-q", "origin", "HEAD")
  run(repo, "submodule", "add", "-q", subRemote, "plugins/x")
  run(repo, "commit", "-qm", "add submodule")
  run(repo, "push", "-q")
  return join(repo, "plugins/x")
}

/** Call once at the top of every test file that uses the helpers below. */
export function useScratchRepos() {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "config-sync-test-"))
    const gitconfig = join(root, "gitconfig")
    writeFileSync(
      gitconfig,
      "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = master\n[protocol \"file\"]\n\tallow = always\n",
    )
    process.env.GIT_CONFIG_GLOBAL = gitconfig
    process.env.GIT_CONFIG_NOSYSTEM = "1"
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))
}
