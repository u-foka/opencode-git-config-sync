import { execFile } from "node:child_process"
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface ChangedFile {
  readonly code: string
  readonly path: string
  readonly added: number | undefined
  readonly removed: number | undefined
  readonly submodule: boolean
}

export interface SyncStatus {
  readonly ahead: number
  readonly behind: number
  readonly files: readonly ChangedFile[]
  /** Submodules with uncommitted work inside; that work is never committed by the config repo. */
  readonly dirtySubmodules: readonly string[]
  /** Submodules checked out at a commit that is on none of their remote branches; pushing the config repo would fail. */
  readonly unpushedSubmodules: readonly string[]
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
export function git(
  repo: string,
  args: string[],
  options: { timeout?: number; env?: Record<string, string> } = {},
): Promise<string> {
  return new Promise((done, fail) =>
    execFile(
      "git",
      ["-C", repo, ...args],
      {
        maxBuffer: 16 * 1024 * 1024,
        timeout: options.timeout,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...options.env },
      },
      (error, stdout, stderr) =>
        error
          ? fail(new Error(error.killed ? `git ${args[0]} timed out` : (stderr || error.message).trim()))
          : done(stdout),
    ),
  )
}

export const BACKGROUND_TIMEOUT_MS = 60_000

// GIT_TERMINAL_PROMPT=0 does not cover ssh, which asks on the terminal (unknown host key, key passphrase) and would
// hang a background fetch behind the TUI. BatchMode makes it fail instead. An explicit GIT_SSH is left alone.
async function batchSsh(repo: string): Promise<Record<string, string>> {
  if (process.env.GIT_SSH) return {}
  const base =
    process.env.GIT_SSH_COMMAND ||
    (await git(repo, ["config", "--get", "core.sshCommand"]).then((out) => out.trim(), () => "")) ||
    "ssh"
  return { GIT_SSH_COMMAND: `${base} -o BatchMode=yes` }
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
  await git(repo, ["fetch", "--quiet"], { timeout: BACKGROUND_TIMEOUT_MS, env: await batchSsh(repo) }).catch(() => {})
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

// Porcelain v2 tells a moved submodule pointer (committable) apart from uncommitted work inside a submodule (not).
async function changedFiles(repo: string): Promise<{ files: ChangedFile[]; dirtySubmodules: string[] }> {
  const status = await git(repo, ["status", "--porcelain=v2", "-z", "--untracked-files=all"])
  const entries = status.split("\0")
  const files: { code: string; path: string; submodule: boolean }[] = []
  const dirtySubmodules: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry) continue
    const kind = entry[0]
    if (kind === "?") {
      files.push({ code: "??", path: entry.slice(2), submodule: false })
      continue
    }
    if (kind !== "1" && kind !== "2" && kind !== "u") continue
    const fields = entry.split(" ")
    const pathIndex = kind === "1" ? 8 : kind === "2" ? 9 : 10
    const path = fields.slice(pathIndex).join(" ")
    const xy = fields[1]
    const sub = fields[2]
    if (kind === "2") i++
    if (sub.startsWith("S") && (sub[2] === "M" || sub[3] === "U")) dirtySubmodules.push(path)
    if (sub.startsWith("S") && sub[1] !== "C" && xy === ".M") continue
    const code = xy.replaceAll(".", " ")
    files.push({ code: code.trim() || code, path, submodule: sub.startsWith("S") })
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

  const counted = await Promise.all(
    files.map(async ({ code, path, submodule }) => {
      if (submodule) return { code, path, added: undefined, removed: undefined, submodule }
      if (code === "??") return { code, path, added: await countLines(join(repo, path)), removed: 0, submodule }
      const [added, removed] = numstat.get(path) ?? [undefined, undefined]
      return { code, path, added, removed, submodule }
    }),
  )
  return { files: counted, dirtySubmodules }
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

  const { files, dirtySubmodules } = await changedFiles(repo)
  const unpushed = await unpushedSubmodules(repo)
  const ages = await Promise.all(files.map((file) => age(join(repo, file.path))))
  const stale = ages.filter((value) => value !== undefined && value > staleMs).length
  if (stale) reasons.push(`${stale} uncommitted file${stale === 1 ? "" : "s"} older than ${hours}h`)

  return { ahead, behind, files, dirtySubmodules, unpushedSubmodules: unpushed, outdated: reasons.length > 0, reasons }
}

export const unpushedMessage = (paths: readonly string[]) =>
  `${paths.join(", ")} ${paths.length === 1 ? "has" : "have"} commits that are not pushed; push the submodule first`

// Uses the submodules' remote-tracking refs, without fetching: pushing from a submodule updates them right away.
export async function unpushedSubmodules(repo: string): Promise<string[]> {
  const entries = (await git(repo, ["ls-files", "--stage", "-z"])).split("\0").filter((entry) => entry.startsWith("160000 "))
  const paths = entries.map((entry) => entry.slice(entry.indexOf("\t") + 1))
  const unpushed = await Promise.all(
    paths.map(async (path) => {
      const sub = join(repo, path)
      if (!(await exists(join(sub, ".git")))) return false
      const remote = await git(sub, ["branch", "--remotes", "--contains", "HEAD"]).catch(() => "")
      return remote.trim() === ""
    }),
  )
  return paths.filter((_, index) => unpushed[index])
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

// Submodules are checked out to the commit the config repo records. A moved submodule pointer is committed like any
// other change, but work inside a submodule is never committed or pushed.
async function updateSubmodules(repo: string) {
  if (!(await exists(join(repo, ".gitmodules")))) return
  await git(repo, ["submodule", "sync", "--recursive", "--quiet"])
  await git(repo, ["submodule", "update", "--init", "--recursive", "--quiet"])
}

/** Stage everything, so the commit contains exactly what the commit prompt listed. */
export async function stageAll(repo: string) {
  await git(repo, ["add", "--all"])
}

export async function sync(repo: string, message: string | undefined, onStep: (step: SyncStep) => void): Promise<{ pushed: number; pulled: number }> {
  if ((await repoState(repo)) !== "ready") throw new Error("Config repo is not set up; run /config-sync-setup")
  const unpushed = await unpushedSubmodules(repo)
  if (unpushed.length) throw new Error(unpushedMessage(unpushed))
  if (message !== undefined) {
    onStep("commit")
    await git(repo, ["commit", "--quiet", "-m", message])
  }
  // Force a fetch so the counts and the pull reflect the remote's current state, even when the automatic 24h
  // fetch has not run yet.
  await git(repo, ["fetch", "--quiet"])
  const [left, right] = (await git(repo, ["rev-list", "--left-right", "--count", "HEAD...@{u}"])).trim().split(/\\s+/)
  const pushed = Number(left) || 0
  const pulled = Number(right) || 0
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
  return { pushed, pulled }
}

/** Force a fetch regardless of the 24h staleness gate, updating the remote-tracking refs. */
export async function fetchRepo(repo: string): Promise<{ before: number; after: number }> {
  if ((await repoState(repo)) !== "ready") throw new Error("Config repo is not set up; run /config-sync-setup")
  const behind = async () => {
    try {
      return Number((await git(repo, ["rev-list", "--count", "HEAD..@{u}"])).trim()) || 0
    } catch {
      return 0
    }
  }
  const before = await behind()
  await git(repo, ["fetch", "--quiet"])
  const after = await behind()
  return { before, after }
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

// Setup steps run only when the config dir is not a repository, so on failure the `.git` there is ours to delete.
async function undoSetup(repo: string, error: unknown, undo: () => Promise<void>): Promise<never> {
  const message = (error as Error).message
  try {
    await undo()
    await rm(join(repo, ".git"), { recursive: true, force: true })
  } catch (undoError) {
    throw new Error(`${message} (undoing the setup also failed: ${(undoError as Error).message})`)
  }
  throw new Error(`${message} (setup undone, the config folder is as before)`)
}

/** First machine: turn the config dir into a repo and push it to an empty remote. */
export async function setupNew(repo: string, url: string, message: string) {
  if ((await repoState(repo)) !== "no-repo") throw new Error("Config directory is already a git repository")
  if (await remoteBranch(repo, url)) throw new Error("Remote is not empty; use “Pull existing config” instead")
  const gitignore = join(repo, ".gitignore")
  const originalGitignore = await readFile(gitignore, "utf8").catch(() => undefined)
  try {
    await git(repo, ["init", "--quiet"])
    await ensureGitignore(repo)
    await git(repo, ["add", "--all"])
    await git(repo, ["commit", "--quiet", "-m", message])
    await git(repo, ["remote", "add", "origin", url])
    await git(repo, ["push", "--quiet", "-u", "origin", "HEAD"])
  } catch (error) {
    await undoSetup(repo, error, () =>
      originalGitignore === undefined ? rm(gitignore, { force: true }) : writeFile(gitignore, originalGitignore),
    )
  }
}

/** Another machine: adopt the remote config, moving clashing local files to a backup folder first. */
export async function setupExisting(repo: string, url: string): Promise<{ backup?: string; moved: string[] }> {
  if ((await repoState(repo)) !== "no-repo") throw new Error("Config directory is already a git repository")
  const branch = await remoteBranch(repo, url)
  if (!branch) throw new Error("Remote is empty; use “Start new” instead")

  let backup: string | undefined
  const moved: string[] = []
  try {
    await git(repo, ["init", "--quiet", `--initial-branch=${branch}`])
    await git(repo, ["remote", "add", "origin", url])
    await git(repo, ["fetch", "--quiet", "origin"])

    const remoteFiles = (await git(repo, ["ls-tree", "-r", "-z", "--name-only", `origin/${branch}`])).split("\0").filter(Boolean)
    const clashing: string[] = []
    for (const path of remoteFiles) if (await exists(join(repo, path))) clashing.push(path)

    if (clashing.length) {
      backup = `.config-sync-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`
      const gitDir = (await git(repo, ["rev-parse", "--absolute-git-dir"])).trim()
      await mkdir(join(gitDir, "info"), { recursive: true })
      await appendFile(join(gitDir, "info", "exclude"), "\n.config-sync-backup-*/\n")
      for (const path of clashing) {
        const target = join(repo, backup, path)
        await mkdir(dirname(target), { recursive: true })
        await rename(join(repo, path), target)
        moved.push(path)
      }
    }

    await git(repo, ["checkout", "--quiet", "-B", branch, "--track", `origin/${branch}`])
  } catch (error) {
    await undoSetup(repo, error, async () => {
      if (!backup) return
      for (const path of moved) {
        await rm(join(repo, path), { recursive: true, force: true })
        await rename(join(repo, backup, path), join(repo, path))
      }
      await rm(join(repo, backup), { recursive: true, force: true })
    })
  }

  // The checkout succeeded, so the repo is usable; a failed submodule update is retried by the next /config-sync.
  await updateSubmodules(repo)
  return { backup, moved }
}
