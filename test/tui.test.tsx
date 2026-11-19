import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { Plugin, PluginContextProvider } from "@opencode/plugin/tui"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"
import plugin from "../src/tui"
import { fresh, run, syncedRepo, withSubmodule, write, useScratchRepos } from "./helpers"

useScratchRepos()

const COLORS = { base: "#ffffff", muted: "#808080", error: "#ff0000" }

interface Toast {
  readonly title?: string
  readonly message: string
  readonly variant?: string
}

interface Command {
  readonly id: string
  readonly run: () => unknown
}

/** Answers the plugin's dialogs in order: a select gets a value, a prompt gets text (undefined = dismissed). */
type Answer = string | undefined

/** Runs the plugin's setup against `repo` with a fake opencode context that records what the plugin does. */
async function start(repo: string, options: Record<string, unknown> = {}, answers: Answer[] = []) {
  const slots = new Map<string, () => JSX.Element>()
  const toasts: Toast[] = []
  const prompts: { title: string; description?: string; value?: string }[] = []
  let commands: Command[] = []
  const reminders = { outdated: 0, setup: 0 }
  const context = {
    options: { repo, ...options },
    theme: { text: { base: COLORS.base, muted: COLORS.muted, feedback: { error: { base: COLORS.error } } } },
    storage: {
      store: () => [reminders, async (update: (draft: typeof reminders) => void) => update(reminders)],
    },
    ui: {
      slot: (slot: { append: string; render: () => JSX.Element }) => slots.set(slot.append, slot.render),
      toast: { show: (toast: Toast) => toasts.push(toast) },
      dialog: {
        select: async () => answers.shift(),
        prompt: async (prompt: { title: string; description?: string; value?: string }) => {
          prompts.push(prompt)
          return answers.shift()
        },
      },
    },
    keymap: { layer: (layer: () => { commands: Command[] }) => (commands = layer().commands) },
    data: { on: () => () => {} },
  } as unknown as Plugin.Context

  const cleanup = await plugin.setup(context)
  cleanups.push(async () => {
    if (cleanup) await cleanup()
  })

  const render = async (slot: string) => {
    const view = slots.get(slot)
    if (!view) throw new Error(`no ${slot} slot`)
    const setup = await testRender(() => <PluginContextProvider value={context}>{view()}</PluginContextProvider>, {
      width: 80,
      height: 12,
    })
    cleanups.push(() => setup.dispose())
    return setup
  }
  const command = (id: string) => {
    const found = commands.find((entry) => entry.id === id)
    if (!found) throw new Error(`no command ${id}`)
    return found.run()
  }
  return { render, toasts, prompts, command }
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Setup = Awaited<ReturnType<Awaited<ReturnType<typeof start>>["render"]>>

/** Draws frames until `text` shows up (the plugin reads git asynchronously), or returns the last one after 5s. */
async function settle(setup: Setup, text: string) {
  const deadline = Date.now() + 5000
  for (;;) {
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    if (frame.includes(text) || Date.now() > deadline) return frame
    await Bun.sleep(20)
  }
}

/** The foreground color of the first cell on a line that starts the given text. */
function colorOf(setup: Setup, text: string) {
  for (const line of setup.captureSpans().lines) {
    const span = line.spans.find((entry) => entry.text.includes(text))
    if (span) {
      const [r, g, b] = span.fg.toInts()
      const [er, eg, eb] = RGBA.fromHex(COLORS.error).toInts()
      const [mr, mg, mb] = RGBA.fromHex(COLORS.muted).toInts()
      if (r === er && g === eg && b === eb) return "error"
      if (r === mr && g === mg && b === mb) return "muted"
      return "other"
    }
  }
  throw new Error(`"${text}" not on screen:\n${setup.captureCharFrame()}`)
}

describe("sidebar", () => {
  test("a synced repo is in sync", async () => {
    const { render } = await start(syncedRepo().repo)
    const sidebar = await render("sidebar.content")
    expect(await settle(sidebar, "Config in sync")).toContain("Config in sync ✓")
  })

  test("lists changes with line counts, and dirty submodules in red", async () => {
    const { dir, repo } = syncedRepo()
    const sub = withSubmodule(dir, repo)
    write(join(sub, "draft.ts"), "wip\n")
    write(join(repo, "cli.json"), '{\n  "a": 1\n}\n')

    const { render } = await start(repo, { maxFiles: 5 })
    const sidebar = await render("sidebar.content")
    const frame = await settle(sidebar, "m  plugins/x")
    expect(frame).toContain("1 uncommitted")
    expect(frame).toContain("M  cli.json +3 −1")
    expect(frame).toContain("m  plugins/x")
    expect(frame).not.toContain("in sync")
    expect(colorOf(sidebar, "cli.json")).toBe("muted")
    expect(colorOf(sidebar, "plugins/x")).toBe("error")
  })

  test("shows a moved submodule like other changes, without line counts", async () => {
    const { dir, repo } = syncedRepo()
    const sub = withSubmodule(dir, repo)
    run(sub, "commit", "-q", "--allow-empty", "-m", "bump")
    run(sub, "push", "-q")

    const { render } = await start(repo)
    const sidebar = await render("sidebar.content")
    const frame = await settle(sidebar, "M  plugins/x")
    expect(frame).toMatch(/^ {2}M {2}plugins\/x\s*$/m)
    expect(colorOf(sidebar, "plugins/x")).toBe("muted")
  })

  test("flags a moved submodule whose commit is not pushed", async () => {
    const { dir, repo } = syncedRepo()
    const sub = withSubmodule(dir, repo)
    run(sub, "commit", "-q", "--allow-empty", "-m", "bump")

    const { render } = await start(repo)
    const sidebar = await render("sidebar.content")
    expect(await settle(sidebar, "not pushed")).toMatch(/^ {2}M {2}plugins\/x not pushed\s*$/m)
    expect(colorOf(sidebar, "plugins/x")).toBe("error")
  })

  test("adds a row for an already committed pointer whose commit is not pushed", async () => {
    const { dir, repo } = syncedRepo()
    const sub = withSubmodule(dir, repo)
    run(sub, "commit", "-q", "--allow-empty", "-m", "bump")
    run(repo, "commit", "-qam", "bump x")

    const { render } = await start(repo)
    const sidebar = await render("sidebar.content")
    const frame = await settle(sidebar, "not pushed")
    expect(frame).toMatch(/^❗↑ {2}plugins\/x not pushed\s*$/m)
    expect(frame).not.toContain("uncommitted")
    expect(colorOf(sidebar, "plugins/x")).toBe("error")
  })

  test("limits the list to maxFiles", async () => {
    const { repo } = syncedRepo()
    for (const name of ["a", "b", "c", "d"]) write(join(repo, `${name}.md`), "x\n")

    const { render } = await start(repo, { maxFiles: 2 })
    const sidebar = await render("sidebar.content")
    const frame = await settle(sidebar, "more file")
    expect(frame).toContain("4 uncommitted")
    expect(frame).toContain("… 2 more files changed")
    expect(frame).not.toContain("c.md")
  })

  test("warns in red when outdated", async () => {
    const { repo } = syncedRepo()
    write(join(repo, "old.md"), "x\n")
    execFileSync("touch", ["-t", "202001010000", join(repo, "old.md")])

    const { render, toasts } = await start(repo)
    const sidebar = await render("sidebar.content")
    await settle(sidebar, "OUTDATED")
    expect(colorOf(sidebar, "OUTDATED")).toBe("error")
    expect(toasts.map((toast) => toast.variant)).toContain("warning")
  })

  test("suggests setup when the folder is not a repository", async () => {
    const { render, toasts } = await start(fresh("plain"))
    const sidebar = await render("sidebar.content")
    expect(await settle(sidebar, "not in git")).toContain("Config not in git · /config-sync-setup")
    expect(toasts.map((toast) => toast.title)).toContain("Config not synced")
  })
})

describe("footer", () => {
  test("shows ✓ when synced", async () => {
    const { render } = await start(syncedRepo().repo)
    const footer = await render("prompt.footer.status")
    expect(await settle(footer, "cfg ✓")).toContain("cfg ✓")
  })

  test("counts changes and uses the label option", async () => {
    const { repo } = syncedRepo()
    write(join(repo, "a.md"), "x\n")
    const { render } = await start(repo, { label: "conf" })
    const footer = await render("prompt.footer.status")
    expect(await settle(footer, "conf ●1")).toContain("conf ●1")
  })

  test("is red with ❗ when outdated", async () => {
    const { repo } = syncedRepo()
    write(join(repo, "old.md"), "x\n")
    execFileSync("touch", ["-t", "202001010000", join(repo, "old.md")])
    const { render } = await start(repo)
    const footer = await render("prompt.footer.status")
    expect(await settle(footer, "❗ cfg")).toContain("❗ cfg ●1")
    expect(colorOf(footer, "cfg")).toBe("error")
  })

  test("says not synced without a repository", async () => {
    const { render } = await start(fresh("plain"))
    const footer = await render("prompt.footer.status")
    expect(await settle(footer, "cfg not synced")).toContain("cfg not synced")
  })
})

describe("/config-sync", () => {
  test("stages before the prompt and commits with the confirmed message", async () => {
    const { repo, remote } = syncedRepo()
    write(join(repo, "a.md"), "x\n")
    const { command, prompts, toasts } = await start(repo, {}, ["my message"])

    await command("config-sync.sync")
    expect(prompts[0]).toMatchObject({ description: "1 staged file will be committed.", value: "add a.md" })
    expect(run(remote, "log", "-1", "--format=%s").trim()).toBe("my message")
    expect(toasts.at(-1)).toMatchObject({ variant: "success" })
  })

  test("leaves the changes staged when the prompt is dismissed", async () => {
    const { repo, remote } = syncedRepo()
    write(join(repo, "a.md"), "x\n")
    const { command, toasts } = await start(repo, {}, [undefined])

    await command("config-sync.sync")
    expect(run(repo, "diff", "--cached", "--name-only").trim()).toBe("a.md")
    expect(run(remote, "log", "-1", "--format=%s").trim()).toBe("initial")
    expect(toasts.at(-1)?.message).toBe("Config sync cancelled; the changes stay staged")
  })

  test("asks about dirty submodules and cancels without touching anything", async () => {
    const { dir, repo } = syncedRepo()
    const sub = withSubmodule(dir, repo)
    write(join(sub, "draft.ts"), "wip\n")
    write(join(repo, "a.md"), "x\n")
    const { command, prompts, toasts } = await start(repo, {}, ["cancel"])

    await command("config-sync.sync")
    expect(prompts).toEqual([])
    expect(run(repo, "diff", "--cached", "--name-only").trim()).toBe("")
    expect(toasts.at(-1)?.message).toBe("Config sync cancelled")
  })

  test("syncs the rest when dirty submodules are ignored", async () => {
    const { dir, repo, remote } = syncedRepo()
    const sub = withSubmodule(dir, repo)
    write(join(sub, "draft.ts"), "wip\n")
    write(join(repo, "a.md"), "x\n")
    const { command } = await start(repo, {}, ["ignore", "add a"])

    await command("config-sync.sync")
    expect(run(remote, "log", "-1", "--format=%s").trim()).toBe("add a")
  })

  test("is blocked by unpushed submodule commits, before any dialog", async () => {
    const { dir, repo, remote } = syncedRepo()
    const sub = withSubmodule(dir, repo)
    run(sub, "commit", "-q", "--allow-empty", "-m", "bump")
    write(join(repo, "a.md"), "x\n")
    const { command, prompts, toasts } = await start(repo, {}, ["message"])

    await command("config-sync.sync")
    expect(prompts).toEqual([])
    expect(run(repo, "diff", "--cached", "--name-only").trim()).toBe("")
    expect(run(remote, "log", "-1", "--format=%s").trim()).toBe("add submodule")
    expect(toasts.at(-1)).toMatchObject({
      title: "Config sync stopped",
      variant: "error",
      message: "plugins/x has commits that are not pushed; push the submodule first (click to dismiss)",
    })
  })

  test("says so when a sync is already running", async () => {
    const { repo } = syncedRepo()
    write(join(repo, "a.md"), "x\n")
    const { command, toasts } = await start(repo, {}, ["first"])

    const first = command("config-sync.sync")
    await command("config-sync.sync")
    await first
    expect(toasts.map((toast) => toast.message)).toContain("Config sync is already running")
  })
})
