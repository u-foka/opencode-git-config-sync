import { execFile } from "node:child_process"
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface ChangedFile {
  readonly code: string
  readonly path: string
  readonly added: number | undefined
  readonly removed: number | undefined
}

export interface SyncStatus {
  readonly ahead: number
  readonly behind: number
  readonly files: readonly ChangedFile[]
  readonly outdated: boolean
  readonly reasons: readonly string[]
}

export type RepoState = "ready" | "no-repo" | "no-upstream"

export type SyncStep = "commit" | "pull" | "submodules" | "push"

export const DEFAULT_GITIGNORE = `node_modules/

# local service credentials
service.json

# machine-specific overrides
*.local.json
*.local.jsonc

# opencode-git-config-sync backups
.config-sync-backup-*/

# OS junk
.DS_Store
Thumbs.db
desktop.ini
`

// GIT_OPTIONAL_LOCKS=0 keeps `git status` from rewriting the index, which would retrigger the file watcher.
// GIT_TERMINAL_PROMPT=0 makes git fail instead of hanging the TUI on a credential prompt.
export function git(repo: string, args: string[]): Promise<string> {
  return new Promise((done, fail) =>
    execFile(
      "git",
      ["-C", repo, ...args],
      { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout, stderr) => (error ? fail(new Error((stderr || error.message).trim())) : done(stdout)),
    ),
  )
}

const succeeds = (promise: Promise<unknown>) => promise.then(() => true, () => false)

const age = async (path: string) => {
  try {
    return Date.now() - (await stat(path)).mtimeMs
  } catch {
    return undefined
  }
}

const exists = async (path: string) => (await age(path)) !== undefined

/** The global opencode config directory, resolved the same way opencode does (XDG paths on every OS). */
export function configDir(override?: string): string {
  if (override) return override.replace(/^~(?=$|[\\/])/, homedir())
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
}

export async function repoState(repo: string): Promise<RepoState> {
  const inside = await git(repo, ["rev-parse", "--show-toplevel"]).then(
    (out) => out.trim(),
    () => undefined,
  )
  // A config dir nested inside some other repo (e.g. a dotfiles repo) is not ours to manage.
  if (!inside || !(await sameDir(inside, repo))) return "no-repo"
  return (await succeeds(git(repo, ["rev-parse", "--abbrev-ref", "@{u}"]))) ? "ready" : "no-upstream"
}

async function sameDir(left: string, right: string) {
  const [a, b] = await Promise.all([left, right].map((path) => stat(path).catch(() => undefined)))
  return !!a && !!b && a.ino === b.ino && a.dev === b.dev
}

async function fetchIfStale(repo: string, staleMs: number) {
  const gitDir = (await git(repo, ["rev-parse", "--absolute-git-dir"])).trim()
  const fetchAge = await age(join(gitDir, "FETCH_HEAD"))
  if (fetchAge !== undefined && fetchAge < staleMs) return
  await git(repo, ["fetch", "--quiet"]).catch(() => {})
}

async function oldestCommitAge(repo: string, range: string) {
  const out = await git(repo, ["log", "--format=%ct", range])
  const times = out.split("\n").filter(Boolean).map(Number)
  return times.length ? Date.now() - Math.min(...times) * 1000 : 0
}

async function countLines(path: string) {
  try {
    const text = await readFile(path, "utf8")
    if (text.includes("\0")) return undefined
    return text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0)
  } catch {
    return undefined
  }
}

async function changedFiles(repo: string): Promise<ChangedFile[]> {
  const status = await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  const entries = status.split("\0")
  const files: { code: string; path: string }[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry) continue
    const code = entry.slice(0, 2)
    files.push({ code: code.trim() || code, path: entry.slice(3) })
    if (code.includes("R") || code.includes("C")) i++
  }

  const numstat = new Map<string, [number | undefined, number | undefined]>()
  if (await succeeds(git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]))) {
    const out = await git(repo, ["diff", "--numstat", "-z", "--no-renames", "HEAD"])
    for (const row of out.split("\0")) {
      const [added, removed, path] = row.split("\t")
      if (path === undefined) continue
      numstat.set(path, [added === "-" ? undefined : Number(added), removed === "-" ? undefined : Number(removed)])
    }
  }

  return Promise.all(
    files.map(async ({ code, path }) => {
      if (code === "??") return { code, path, added: await countLines(join(repo, path)), removed: 0 }
      const [added, removed] = numstat.get(path) ?? [undefined, undefined]
      return { code, path, added, removed }
    }),
  )
}

export async function readStatus(repo: string, staleMs: number): Promise<SyncStatus> {
  await fetchIfStale(repo, staleMs)
  const [left, right] = (await git(repo, ["rev-list", "--left-right", "--count", "HEAD...@{u}"])).trim().split(/\s+/)
  const ahead = Number(left) || 0
  const behind = Number(right) || 0
  const hours = Math.round(staleMs / 3_600_000)
  const reasons: string[] = []
  if (ahead && (await oldestCommitAge(repo, "@{u}..HEAD")) > staleMs) reasons.push(`${ahead} to push for over ${hours}h`)
  if (behind && (await oldestCommitAge(repo, "HEAD..@{u}")) > staleMs) reasons.push(`${behind} to pull for over ${hours}h`)

  const files = await changedFiles(repo)
  const ages = await Promise.all(files.map((file) => age(join(repo, file.path))))
  const stale = ages.filter((value) => value !== undefined && value > staleMs).length
  if (stale) reasons.push(`${stale} uncommitted file${stale === 1 ? "" : "s"} older than ${hours}h`)

  return { ahead, behind, files, outdated: reasons.length > 0, reasons }
}

export function proposeMessage(files: readonly ChangedFile[]): string {
  const groups = new Map<string, Set<string>>()
  for (const file of files) {
    const parts = file.path.split("/")
    const target = parts.length > 2 ? parts.slice(0, 2).join("/") : file.path
    const verb = file.code === "??" || file.code === "A" ? "add" : file.code === "D" ? "remove" : "update"
    groups.set(verb, (groups.get(verb) ?? new Set()).add(target))
  }
  const phrases: string[] = []
  for (const verb of ["update", "add", "remove"]) {
    const targets = [...(groups.get(verb) ?? [])]
    if (!targets.length) continue
    const listed = targets.slice(0, 3).join(", ")
    phrases.push(`${verb} ${listed}${targets.length > 3 ? ` (+${targets.length - 3} more)` : ""}`)
  }
  return phrases.join("; ") || "config updates"
}

// Submodules are only checked out to the commit the config repo records; they are never committed or pushed.
async function updateSubmodules(repo: string) {
  if (!(await exists(join(repo, ".gitmodules")))) return
  await git(repo, ["submodule", "sync", "--recursive", "--quiet"])
  await git(repo, ["submodule", "update", "--init", "--recursive", "--quiet"])
}

export async function sync(repo: string, message: string | undefined, onStep: (step: SyncStep) => void) {
  if ((await repoState(repo)) !== "ready") throw new Error("Config repo is not set up; run /config-sync-setup")
  if (message !== undefined) {
    onStep("commit")
    await git(repo, ["add", "--all"])
    await git(repo, ["commit", "--quiet", "-m", message])
  }
  onStep("pull")
  try {
    await git(repo, ["pull", "--rebase", "--quiet", "--no-recurse-submodules"])
  } catch (error) {
    const gitDir = (await git(repo, ["rev-parse", "--absolute-git-dir"])).trim()
    const rebasing = (await exists(join(gitDir, "rebase-merge"))) || (await exists(join(gitDir, "rebase-apply")))
    if (rebasing) await git(repo, ["rebase", "--abort"]).catch(() => {})
    throw new Error(`Pull --rebase failed${rebasing ? " (rebase aborted, your commit is kept)" : ""}: ${(error as Error).message}`)
  }
  onStep("submodules")
  await updateSubmodules(repo)
  onStep("push")
  // "check" refuses to push a submodule pointer whose commit is not on the submodule's remote yet.
  await git(repo, ["push", "--quiet", "--recurse-submodules=check"])
}

async function remoteBranch(repo: string, url: string): Promise<string | undefined> {
  const heads = (await git(repo, ["ls-remote", "--heads", url]))
    .split("\n")
    .map((line) => line.split("\trefs/heads/")[1])
    .filter((name): name is string => !!name)
  if (!heads.length) return undefined
  const symref = (await git(repo, ["ls-remote", "--symref", url, "HEAD"])).match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1]
  return [symref, "main", "master"].find((name) => name && heads.includes(name)) ?? heads[0]
}

async function ensureGitignore(repo: string) {
  const path = join(repo, ".gitignore")
  const current = await readFile(path, "utf8").catch(() => undefined)
  if (current === undefined) return writeFile(path, DEFAULT_GITIGNORE)
  const lines = new Set(current.split(/\r?\n/))
  const missing = DEFAULT_GITIGNORE.split("\n").filter((line) => line && !line.startsWith("#") && !lines.has(line))
  if (missing.length) await appendFile(path, `${current.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`)
}

/** First machine: turn the config dir into a repo and push it to an empty remote. */
export async function setupNew(repo: string, url: string, message: string) {
  if ((await repoState(repo)) !== "no-repo") throw new Error("Config directory is already a git repository")
  if (await remoteBranch(repo, url)) throw new Error("Remote is not empty; use “Pull existing config” instead")
  await git(repo, ["init", "--quiet"])
  await ensureGitignore(repo)
  await git(repo, ["add", "--all"])
  await git(repo, ["commit", "--quiet", "-m", message])
  await git(repo, ["remote", "add", "origin", url])
  await git(repo, ["push", "--quiet", "-u", "origin", "HEAD"])
}

/** Another machine: adopt the remote config, moving clashing local files to a backup folder first. */
export async function setupExisting(repo: string, url: string): Promise<{ backup?: string; moved: string[] }> {
  if ((await repoState(repo)) !== "no-repo") throw new Error("Config directory is already a git repository")
  const branch = await remoteBranch(repo, url)
  if (!branch) throw new Error("Remote is empty; use “Start new” instead")
  await git(repo, ["init", "--quiet", `--initial-branch=${branch}`])
  await git(repo, ["remote", "add", "origin", url])
  await git(repo, ["fetch", "--quiet", "origin"])

  const remoteFiles = (await git(repo, ["ls-tree", "-r", "-z", "--name-only", `origin/${branch}`])).split("\0").filter(Boolean)
  const clashing: string[] = []
  for (const path of remoteFiles) if (await exists(join(repo, path))) clashing.push(path)

  let backup: string | undefined
  if (clashing.length) {
    backup = `.config-sync-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`
    const gitDir = (await git(repo, ["rev-parse", "--absolute-git-dir"])).trim()
    await mkdir(join(gitDir, "info"), { recursive: true })
    await appendFile(join(gitDir, "info", "exclude"), "\n.config-sync-backup-*/\n")
    for (const path of clashing) {
      const target = join(repo, backup, path)
      await mkdir(dirname(target), { recursive: true })
      await rename(join(repo, path), target)
    }
  }

  await git(repo, ["checkout", "--quiet", "-B", branch, "--track", `origin/${branch}`])
  await updateSubmodules(repo)
  return { backup, moved: clashing }
}
