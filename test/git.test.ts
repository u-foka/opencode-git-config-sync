import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { DAY_MS, fresh, otherMachine, run, syncedRepo, withSubmodule, write, useScratchRepos } from "./helpers"
import { configDir, git, proposeMessage, readStatus, repoState, setupExisting, setupNew, stageAll, sync, type ChangedFile } from "../src/git"

useScratchRepos()

describe("configDir", () => {
  test("expands ~ in the override", () => {
    expect(configDir("~/cfg")).toBe(join(homedir(), "cfg"))
  })
  test("keeps other overrides as they are", () => {
    expect(configDir("/abs/cfg")).toBe("/abs/cfg")
  })
})

describe("repoState", () => {
  test("no-repo for a plain folder", async () => {
    expect(await repoState(fresh("plain"))).toBe("no-repo")
  })
  test("no-repo for a folder nested inside another repository", async () => {
    const outer = fresh("dotfiles")
    run(outer, "init", "-q")
    mkdirSync(join(outer, "opencode"))
    expect(await repoState(join(outer, "opencode"))).toBe("no-repo")
  })
  test("no-upstream for a repository without a tracking branch", async () => {
    const repo = fresh("local")
    run(repo, "init", "-q")
    expect(await repoState(repo)).toBe("no-upstream")
  })
  test("ready for a clone", async () => {
    expect(await repoState(syncedRepo().repo)).toBe("ready")
  })
})

describe("readStatus", () => {
  test("a synced repo has nothing to report", async () => {
    const status = await readStatus(syncedRepo().repo, DAY_MS)
    expect(status).toEqual({
      ahead: 0,
      behind: 0,
      files: [],
      dirtySubmodules: [],
      unpushedSubmodules: [],
      outdated: false,
      reasons: [],
    })
  })

  test("lists staged, unstaged and untracked changes together, with line counts", async () => {
    const { repo } = syncedRepo({ "cli.json": "{}\n", "keep.md": "a\nb\n", "gone.md": "x\n" })
    write(join(repo, "cli.json"), '{\n  "a": 1\n}\n')
    run(repo, "add", "cli.json")
    write(join(repo, "cli.json"), '{\n  "a": 2\n}\n')
    write(join(repo, "keep.md"), "a\nB\n")
    rmSync(join(repo, "gone.md"))
    write(join(repo, "skills/my skill.md"), "one\ntwo\nthree\n")

    const { files } = await readStatus(repo, DAY_MS)
    const byPath = Object.fromEntries(files.map((file) => [file.path, file]))
    expect(byPath["cli.json"]).toMatchObject({ code: "MM", added: 3, removed: 1, submodule: false })
    expect(byPath["keep.md"]).toMatchObject({ code: "M", added: 1, removed: 1 })
    expect(byPath["gone.md"]).toMatchObject({ code: "D", added: 0, removed: 1 })
    expect(byPath["skills/my skill.md"]).toMatchObject({ code: "??", added: 3, removed: 0 })
    expect(files).toHaveLength(4)
  })

  test("reports a staged rename once, under its new path", async () => {
    const { repo } = syncedRepo({ "old.md": "text\n" })
    run(repo, "mv", "old.md", "new name.md")
    const { files } = await readStatus(repo, DAY_MS)
    expect(files.map((file) => [file.code, file.path])).toEqual([["R", "new name.md"]])
  })

  test("counts commits to push and to pull", async () => {
    const { dir, remote, repo } = syncedRepo()
    const other = otherMachine(dir, remote)
    write(join(other, "a.md"), "a\n")
    run(other, "add", "-A")
    run(other, "commit", "-qm", "from other")
    run(other, "push", "-q")
    write(join(repo, "b.md"), "b\n")
    run(repo, "add", "-A")
    run(repo, "commit", "-qm", "local")

    const status = await readStatus(repo, 0)
    expect(status).toMatchObject({ ahead: 1, behind: 1, files: [] })
  })

  test("marks old unpushed commits and old uncommitted files as outdated", async () => {
    const { repo } = syncedRepo()
    write(join(repo, "a.md"), "a\n")
    run(repo, "add", "-A")
    execFileSync("git", ["commit", "-qm", "old"], {
      cwd: repo,
      env: { ...process.env, GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z", GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z" },
    })
    write(join(repo, "b.md"), "b\n")
    execFileSync("touch", ["-t", "202001010000", join(repo, "b.md")])

    const status = await readStatus(repo, DAY_MS)
    expect(status.outdated).toBe(true)
    expect(status.reasons).toEqual(["1 to push for over 24h", "1 uncommitted file older than 24h"])
  })

  test("fresh changes are not outdated", async () => {
    const { repo } = syncedRepo()
    write(join(repo, "a.md"), "a\n")
    expect((await readStatus(repo, DAY_MS)).outdated).toBe(false)
  })
})

describe("background fetch", () => {
  // A fake ssh that records its arguments, then waits as if prompting.
  function fakeSsh(dir: string, sleep: number) {
    const script = join(dir, "fake-ssh")
    write(script, `#!/bin/sh\necho "$@" >> "${join(dir, "ssh-args")}"\nsleep ${sleep}\nexit 1\n`)
    chmodSync(script, 0o755)
    return script
  }

  test("runs ssh in batch mode, keeping the configured ssh command", async () => {
    const { dir, repo } = syncedRepo()
    run(repo, "remote", "set-url", "origin", "ssh://example.invalid/x.git")
    run(repo, "config", "core.sshCommand", fakeSsh(dir, 0))
    await readStatus(repo, 0)
    expect(readFileSync(join(dir, "ssh-args"), "utf8")).toContain("-o BatchMode=yes")
  })

  test("a hanging git command is stopped by the timeout", async () => {
    const { dir, repo } = syncedRepo()
    run(repo, "remote", "set-url", "origin", "ssh://example.invalid/x.git")
    run(repo, "config", "core.sshCommand", fakeSsh(dir, 10))
    const started = Date.now()
    await expect(git(repo, ["fetch", "--quiet"], { timeout: 300 })).rejects.toThrow("git fetch timed out")
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe("readStatus with submodules", () => {
  test("work inside a submodule is reported as dirty, not as a change", async () => {
    const { dir, repo } = syncedRepo()
    const sub = withSubmodule(dir, repo)
    write(join(sub, "draft.ts"), "wip\n")

    const status = await readStatus(repo, DAY_MS)
    expect(status.files).toEqual([])
    expect(status.dirtySubmodules).toEqual(["plugins/x"])
  })

  test("a moved submodule is a change without line counts", async () => {
    const { dir, repo } = syncedRepo()
    const sub = withSubmodule(dir, repo)
    run(sub, "commit", "-q", "--allow-empty", "-m", "bump")

    const status = await readStatus(repo, DAY_MS)
    expect(status.files).toEqual([{ code: "M", path: "plugins/x", added: undefined, removed: undefined, submodule: true }])
    expect(status.dirtySubmodules).toEqual([])
    expect(status.unpushedSubmodules).toEqual(["plugins/x"])
  })

  test("a moved submodule is no longer unpushed once its commit is pushed", async () => {
    const { dir, repo } = syncedRepo()
    const sub = withSubmodule(dir, repo)
    run(sub, "commit", "-q", "--allow-empty", "-m", "bump")
    run(sub, "push", "-q")

    const status = await readStatus(repo, DAY_MS)
    expect(status.files.map((file) => file.path)).toEqual(["plugins/x"])
    expect(status.unpushedSubmodules).toEqual([])
  })

  test("an already committed pointer to an unpushed commit is still unpushed", async () => {
    const { dir, repo } = syncedRepo()
    const sub = withSubmodule(dir, repo)
    run(sub, "commit", "-q", "--allow-empty", "-m", "bump")
    run(repo, "commit", "-qam", "bump x")

    const status = await readStatus(repo, DAY_MS)
    expect(status).toMatchObject({ ahead: 1, files: [], unpushedSubmodules: ["plugins/x"] })
  })

  test("a moved submodule with work inside is both a change and dirty", async () => {
    const { dir, repo } = syncedRepo()
    const sub = withSubmodule(dir, repo)
    run(sub, "commit", "-q", "--allow-empty", "-m", "bump")
    write(join(sub, "draft.ts"), "wip\n")

    const status = await readStatus(repo, DAY_MS)
    expect(status.files.map((file) => file.path)).toEqual(["plugins/x"])
    expect(status.dirtySubmodules).toEqual(["plugins/x"])
  })
})

describe("proposeMessage", () => {
  const file = (code: string, path: string): ChangedFile => ({ code, path, added: 1, removed: 0, submodule: false })

  test("groups by verb and by the first two path levels", () => {
    expect(
      proposeMessage([
        file("M", "cli.json"),
        file("??", "skills/foo/SKILL.md"),
        file("??", "skills/foo/notes.md"),
        file("D", "agents/old.md"),
      ]),
    ).toBe("update cli.json; add skills/foo; remove agents/old.md")
  })

  test("shortens long lists", () => {
    const files = ["a", "b", "c", "d", "e"].map((name) => file("M", `${name}.md`))
    expect(proposeMessage(files)).toBe("update a.md, b.md, c.md (+2 more)")
  })

  test("falls back to a generic message", () => {
    expect(proposeMessage([])).toBe("config updates")
  })
})

describe("sync", () => {
  test("commits what is staged, then pushes", async () => {
    const { dir, remote, repo } = syncedRepo()
    write(join(repo, "a.md"), "a\n")
    await stageAll(repo)
    write(join(repo, "late.md"), "changed after the prompt\n")

    const steps: string[] = []
    await sync(repo, "add a", (step) => steps.push(step))
    expect(steps).toEqual(["commit", "pull", "submodules", "push"])
    expect(run(remote, "log", "-1", "--format=%s").trim()).toBe("add a")
    expect(run(remote, "show", "--name-only", "--format=", "HEAD").trim()).toBe("a.md")
    expect(existsSync(join(otherMachine(dir, remote), "late.md"))).toBe(false)
    expect((await readStatus(repo, DAY_MS)).files.map((file) => file.path)).toEqual(["late.md"])
  })

  test("pulls with rebase before pushing", async () => {
    const { dir, remote, repo } = syncedRepo()
    const other = otherMachine(dir, remote)
    write(join(other, "theirs.md"), "t\n")
    run(other, "add", "-A")
    run(other, "commit", "-qm", "theirs")
    run(other, "push", "-q")
    write(join(repo, "mine.md"), "m\n")
    await stageAll(repo)

    await sync(repo, "mine", () => {})
    expect(run(remote, "log", "--format=%s").trim().split("\n")).toEqual(["mine", "theirs", "initial"])
  })

  test("aborts a conflicting rebase and keeps the local commit", async () => {
    const { dir, remote, repo } = syncedRepo()
    const other = otherMachine(dir, remote)
    write(join(other, "cli.json"), '{ "theirs": true }\n')
    run(other, "commit", "-qam", "theirs")
    run(other, "push", "-q")
    write(join(repo, "cli.json"), '{ "mine": true }\n')
    await stageAll(repo)

    await expect(sync(repo, "mine", () => {})).rejects.toThrow(/rebase aborted, your commit is kept/)
    expect(run(repo, "log", "-1", "--format=%s").trim()).toBe("mine")
    expect(existsSync(join(run(repo, "rev-parse", "--absolute-git-dir").trim(), "rebase-merge"))).toBe(false)
  })

  test("without a message it only pulls and pushes", async () => {
    const { repo, remote } = syncedRepo()
    write(join(repo, "a.md"), "a\n")
    run(repo, "add", "-A")
    run(repo, "commit", "-qm", "already committed")

    const steps: string[] = []
    await sync(repo, undefined, (step) => steps.push(step))
    expect(steps).toEqual(["pull", "submodules", "push"])
    expect(run(remote, "log", "-1", "--format=%s").trim()).toBe("already committed")
  })

  test("syncs the rest while a submodule has uncommitted work", async () => {
    const { dir, remote, repo } = syncedRepo()
    const sub = withSubmodule(dir, repo)
    write(join(sub, "draft.ts"), "wip\n")
    write(join(repo, "a.md"), "a\n")
    await stageAll(repo)

    await sync(repo, "add a", () => {})
    expect(run(remote, "log", "-1", "--format=%s").trim()).toBe("add a")
    expect(readFileSync(join(sub, "draft.ts"), "utf8")).toBe("wip\n")
  })

  test("stops before committing when a submodule commit is not pushed", async () => {
    const { dir, remote, repo } = syncedRepo()
    const sub = withSubmodule(dir, repo)
    run(sub, "commit", "-q", "--allow-empty", "-m", "not pushed")
    await stageAll(repo)

    const steps: string[] = []
    await expect(sync(repo, "bump x", (step) => steps.push(step))).rejects.toThrow(
      "plugins/x has commits that are not pushed; push the submodule first",
    )
    expect(steps).toEqual([])
    expect(run(repo, "log", "-1", "--format=%s").trim()).toBe("add submodule")
    expect(run(remote, "log", "-1", "--format=%s").trim()).toBe("add submodule")
  })

  test("refuses to run before setup", async () => {
    await expect(sync(fresh("plain"), undefined, () => {})).rejects.toThrow(/config-sync-setup/)
  })
})

describe("setupNew", () => {
  test("creates the repo with a .gitignore and pushes it", async () => {
    const dir = fresh("new")
    const remote = join(dir, "remote.git")
    const repo = join(dir, "config")
    run(dir, "init", "-q", "--bare", remote)
    write(join(repo, "cli.json"), "{}\n")
    write(join(repo, "service.json"), "secret\n")

    await setupNew(repo, remote, "initial import")
    expect(await repoState(repo)).toBe("ready")
    const pushed = run(remote, "ls-tree", "-r", "--name-only", "HEAD").trim().split("\n")
    expect(pushed).toEqual([".gitignore", "cli.json"])
  })

  test("adds only the missing lines to an existing .gitignore", async () => {
    const dir = fresh("new")
    const remote = join(dir, "remote.git")
    const repo = join(dir, "config")
    run(dir, "init", "-q", "--bare", remote)
    write(join(repo, ".gitignore"), "mine\nnode_modules/")

    await setupNew(repo, remote, "initial import")
    const lines = readFileSync(join(repo, ".gitignore"), "utf8").split("\n")
    expect(lines.slice(0, 2)).toEqual(["mine", "node_modules/"])
    expect(lines.filter((line) => line === "node_modules/")).toHaveLength(1)
    expect(lines).toContain("service.json")
  })

  test("refuses a remote that already has commits", async () => {
    const { remote } = syncedRepo()
    const repo = fresh("config")
    await expect(setupNew(repo, remote, "initial import")).rejects.toThrow(/not empty/)
    expect(existsSync(join(repo, ".git"))).toBe(false)
  })

  test("undoes everything when the push fails", async () => {
    const dir = fresh("new")
    const remote = join(dir, "remote.git")
    const repo = join(dir, "config")
    run(dir, "init", "-q", "--bare", remote)
    write(join(remote, "hooks/pre-receive"), "#!/bin/sh\necho denied >&2\nexit 1\n")
    chmodSync(join(remote, "hooks/pre-receive"), 0o755)
    write(join(repo, "cli.json"), "{}\n")
    write(join(repo, ".gitignore"), "mine\n")

    await expect(setupNew(repo, remote, "initial import")).rejects.toThrow(/setup undone/)
    expect(readdirSync(repo).sort()).toEqual([".gitignore", "cli.json"])
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe("mine\n")
    expect(await repoState(repo)).toBe("no-repo")
  })

  test("removes a .gitignore it created when the push fails", async () => {
    const dir = fresh("new")
    const remote = join(dir, "remote.git")
    const repo = join(dir, "config")
    run(dir, "init", "-q", "--bare", remote)
    write(join(remote, "hooks/pre-receive"), "#!/bin/sh\nexit 1\n")
    chmodSync(join(remote, "hooks/pre-receive"), 0o755)
    write(join(repo, "cli.json"), "{}\n")

    await setupNew(repo, remote, "initial import").catch(() => {})
    expect(readdirSync(repo)).toEqual(["cli.json"])
  })
})

describe("setupExisting", () => {
  test("checks out the remote, backing up clashing local files", async () => {
    const { dir, remote } = syncedRepo({ "cli.json": '{ "remote": true }\n', "skills/a.md": "a\n" })
    const repo = join(dir, "machine")
    write(join(repo, "cli.json"), '{ "local": true }\n')
    write(join(repo, "local-only.md"), "mine\n")

    const result = await setupExisting(repo, remote)
    expect(result.moved).toEqual(["cli.json"])
    expect(result.backup).toMatch(/^\.config-sync-backup-/)
    expect(readFileSync(join(repo, "cli.json"), "utf8")).toBe('{ "remote": true }\n')
    expect(readFileSync(join(repo, result.backup!, "cli.json"), "utf8")).toBe('{ "local": true }\n')
    expect(readFileSync(join(repo, "local-only.md"), "utf8")).toBe("mine\n")
    expect(await repoState(repo)).toBe("ready")
    expect((await readStatus(repo, DAY_MS)).files.map((file) => file.path)).toEqual(["local-only.md"])
  })

  test("checks out submodules", async () => {
    const { dir, remote, repo: first } = syncedRepo()
    withSubmodule(dir, first)
    const repo = fresh("machine")

    await setupExisting(repo, remote)
    expect(readFileSync(join(repo, "plugins/x/index.ts"), "utf8")).toBe("export {}\n")
  })

  test("refuses an empty remote", async () => {
    const dir = fresh("existing")
    const remote = join(dir, "remote.git")
    run(dir, "init", "-q", "--bare", remote)
    await expect(setupExisting(fresh("machine"), remote)).rejects.toThrow(/empty/)
  })

  test("undoes everything, restoring backed-up files, when the checkout fails", async () => {
    const { dir, remote } = syncedRepo({ "a.txt": "remote\n", "sub/new.txt": "remote\n" })
    const repo = join(dir, "machine")
    write(join(repo, "a.txt"), "local\n")
    write(join(repo, "sub"), "a file where the remote has a folder\n")

    await expect(setupExisting(repo, remote)).rejects.toThrow(/setup undone/)
    expect(readdirSync(repo).sort()).toEqual(["a.txt", "sub"])
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("local\n")
    expect(await repoState(repo)).toBe("no-repo")
  })
})
