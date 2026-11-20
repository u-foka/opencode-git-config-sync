/** @jsxImportSource @opentui/solid */
import { watch, type FSWatcher } from "node:fs"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createSignal, For, Match, Show, Switch } from "solid-js"
import {
  configDir,
  fetchRepo,
  proposeMessage,
  readStatus,
  repoState,
  setupExisting,
  setupNew,
  stageAll,
  sync,
  unpushedMessage,
  type ChangedFile,
  type RepoState,
  type SyncStatus,
} from "./git"

const HOUR_MS = 60 * 60 * 1000
const STICKY_MS = 2_147_483_647
const WATCH_DEBOUNCE_MS = 500
// Git internals that churn without changing what the plugin shows, plus dependency folders.
const IGNORED = [/^\.git\/(objects|logs)\//, /\.lock$/, /(^|\/)node_modules(\/|$)/]

interface Options {
  readonly repo?: string
  readonly staleHours?: number
  readonly refreshMinutes?: number
  readonly maxFiles?: number
  readonly label?: string
}

type View = { state: Exclude<RepoState, "ready"> } | { state: "ready"; status: SyncStatus }

const [view, setView] = createSignal<View | undefined>()
const [settings, setSettings] = createSignal({ maxFiles: 3, label: "cfg" })

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

const lineCounts = (file: ChangedFile) =>
  file.submodule
    ? ""
    : [file.added ? `+${file.added}` : "", file.removed ? `−${file.removed}` : ""].filter(Boolean).join(" ") ||
      (file.added === undefined ? "bin" : "")

interface Row {
  readonly text: string
  /** Needs action before it syncs: uncommitted work inside a submodule, or submodule commits that are not pushed. */
  readonly warn: boolean
}

// Committable changes first, then submodules that need action but are not a change themselves: "m" (as in git's short
// status) for uncommitted work inside, "↑" for an already committed pointer whose commits are not pushed.
function rows(status: SyncStatus): Row[] {
  const dirty = new Set(status.dirtySubmodules)
  const unpushed = new Set(status.unpushedSubmodules)
  const listed = new Set(status.files.map((file) => file.path))
  const note = (path: string) => (unpushed.has(path) ? " not pushed" : "")
  const extra = [...new Set([...status.dirtySubmodules, ...status.unpushedSubmodules])].filter((path) => !listed.has(path))
  return [
    ...status.files.map((file) => ({
      text: `  ${file.code.padEnd(2)} ${file.path} ${lineCounts(file)}`.trimEnd() + note(file.path),
      warn: dirty.has(file.path) || unpushed.has(file.path),
    })),
    // A committed pointer to an unpushed commit is one push away from breaking the submodule update on the other
    // machines. ❗ is two cells wide and replaces the indent, so the row stays aligned with the others.
    ...extra.map((path) => ({
      text: `${unpushed.has(path) ? "❗" : "  "}${dirty.has(path) ? "m " : "↑ "} ${path}${note(path)}`,
      warn: true,
    })),
  ]
}

function summary(status: SyncStatus) {
  const parts = [
    status.ahead ? `↑${status.ahead}` : "",
    status.behind ? `↓${status.behind}` : "",
    status.files.length ? `●${status.files.length}` : "",
  ]
  const text = parts.filter(Boolean).join(" ")
  return `${settings().label} ${text || "✓"}`
}

function FooterStatus() {
  const context = usePlugin()
  return (
    <Switch>
      <Match when={view()?.state === "ready" && (view() as { status: SyncStatus }).status}>
        {(status) => (
          <text fg={status().outdated ? context.theme.text.feedback.error.base : context.theme.text.muted}>
            {(status().outdated ? "❗ " : "") + summary(status())}
          </text>
        )}
      </Match>
      <Match when={view()}>
        <text fg={context.theme.text.muted}>{`${settings().label} not synced`}</text>
      </Match>
    </Switch>
  )
}

function SidebarStatus() {
  const context = usePlugin()
  return (
    <Switch>
      <Match when={view()?.state === "ready" && (view() as { status: SyncStatus }).status}>
        {(status) => {
          const all = () => rows(status())
          const shown = () => all().slice(0, settings().maxFiles)
          const more = () => all().length - shown().length
          return (
            <box flexDirection="column">
              <Show when={status().outdated}>
                <text fg={context.theme.text.feedback.error.base}>❗ OUTDATED!</text>
              </Show>
              <text fg={context.theme.text.base}>
                {"Config "}
                {status().ahead || status().behind
                  ? `↑${status().ahead} to push · ↓${status().behind} to pull`
                  : status().files.length || status().dirtySubmodules.length || status().unpushedSubmodules.length
                    ? status().files.length === 0 &&
                      (status().dirtySubmodules.length > 0 || status().unpushedSubmodules.length > 0)
                      ? "needs some love ❤️"
                      : ""
                    : "in sync ✓"}
              </text>
              <Show when={status().files.length}>
                <text fg={context.theme.text.muted}>{`${status().files.length} uncommitted`}</text>
              </Show>
              <For each={shown()}>
                {(row) => (
                  <text fg={row.warn ? context.theme.text.feedback.error.base : context.theme.text.muted}>{row.text}</text>
                )}
              </For>
              <Show when={more() > 0}>
                <text fg={context.theme.text.muted}>{`  … ${plural(more(), "more file")} changed`}</text>
              </Show>
            </box>
          )
        }}
      </Match>
      <Match when={view()}>
        {(current) => (
          <text fg={context.theme.text.muted}>
            {current().state === "no-repo" ? "Config not in git · /config-sync-setup" : "Config repo has no upstream"}
          </text>
        )}
      </Match>
    </Switch>
  )
}

export default Plugin.define({
  id: "opencode-git-config-sync",
  setup(context) {
    const options = (context.options ?? {}) as Options
    const repo = configDir(options.repo)
    const staleMs = (options.staleHours ?? 24) * HOUR_MS
    const refreshMs = (options.refreshMinutes ?? 5) * 60 * 1000
    setSettings({ maxFiles: options.maxFiles ?? 3, label: options.label ?? "cfg" })

    const [reminders, setReminders] = context.storage.store("reminders", { initial: { outdated: 0, setup: 0 } })
    let running = false
    let pending = false
    let busy = false
    let idle = Promise.resolve()
    let disposed = false
    // A refresh can still be running when the plugin is unloaded; its result must not overwrite a newer view.
    const show = (next: View | undefined) => {
      if (!disposed) setView(next)
    }

    const remind = async (kind: "outdated" | "setup", force: boolean, show: () => void) => {
      if (!force && Date.now() - reminders[kind] < staleMs) return
      await setReminders((draft) => {
        draft[kind] = Date.now()
      })
      show()
    }

    // Refreshes are skipped while a sync or setup runs (and those wait for an in-flight one), so a refresh's
    // `git fetch` can't race the pull for ref locks. `exclusive` refreshes once its task finishes.
    const refresh = async (force = false) => {
      if (busy) return
      if (running) {
        pending = true
        return
      }
      running = true
      let settle = () => {}
      idle = new Promise((resolve) => (settle = resolve))
      try {
        const state = await repoState(repo)
        if (state !== "ready") {
          show({ state })
          if (state === "no-repo")
            await remind("setup", force, () =>
              context.ui.toast.show({
                title: "Config not synced",
                message: "Your opencode config folder is not a git repository. Run /config-sync-setup to sync it.",
                variant: "info",
                duration: 10_000,
              }),
            )
          return
        }
        const status = await readStatus(repo, staleMs)
        show({ state, status })
        if (status.outdated)
          await remind("outdated", force, () =>
            context.ui.toast.show({
              title: "⚠️ OPENCODE CONFIG REPO OUT OF SYNC",
              message: `${status.reasons.join(" · ")}. Run /config-sync when ready. (click to dismiss)`,
              variant: "warning",
              duration: STICKY_MS,
            }),
          )
      } catch {
        show(undefined)
      } finally {
        running = false
        settle()
        if (pending) {
          pending = false
          void refresh()
        }
      }
    }

    const failed = (title: string, error: unknown) =>
      context.ui.toast.show({
        title,
        message: `${(error as Error).message} (click to dismiss)`,
        variant: "error",
        duration: STICKY_MS,
      })

    const exclusive = async (task: () => Promise<void>) => {
      if (busy) return context.ui.toast.show({ message: "Config sync is already running", variant: "info" })
      busy = true
      pending = false
      try {
        await idle
        await task()
      } finally {
        busy = false
        void refresh()
      }
    }

    const runSync = () =>
      exclusive(async () => {
        try {
          if ((await repoState(repo)) === "no-repo") return void (await runSetup())
          const status = await readStatus(repo, staleMs)
          // Checked before any dialog or staging. Pushing such a pointer would break the submodule update on every
          // other machine (and the push refuses it anyway).
          if (status.unpushedSubmodules.length) return failed("Config sync stopped", new Error(unpushedMessage(status.unpushedSubmodules)))
          if (status.dirtySubmodules.length) {
            const proceed = await context.ui.dialog.select({
              title: "Submodules have uncommitted work",
              options: [
                {
                  title: "Ignore and sync the rest",
                  value: "ignore",
                  description: `Leaves the work in ${status.dirtySubmodules.join(", ")} uncommitted`,
                },
                { title: "Cancel", value: "cancel", description: "Commit or discard the submodule work first" },
              ],
            })
            if (proceed !== "ignore") return context.ui.toast.show({ message: "Config sync cancelled", variant: "info" })
          }
          let message: string | undefined
          if (status.files.length) {
            await stageAll(repo)
            const staged = await readStatus(repo, staleMs)
            message = (
              await context.ui.dialog.prompt({
                title: "Commit config changes",
                description: `${plural(staged.files.length, "staged file")} will be committed.`,
                value: proposeMessage(staged.files),
              })
            )?.trim()
            if (!message)
              return context.ui.toast.show({ message: "Config sync cancelled; the changes stay staged", variant: "info" })
          }
          const result = await sync(repo, message, (step) =>
            context.ui.toast.show({ message: `Config sync: ${step}…`, variant: "info", duration: 2000 }),
          )
          context.ui.toast.show({
            title: "Config sync",
            message: `Config repo synced ✓ (↑${result.pushed} pushed, ↓${result.pulled} pulled)`,
            variant: "success",
          })
        } catch (error) {
          failed("Config sync failed", error)
        }
      })

    const runFetch = () =>
      exclusive(async () => {
        try {
          const state = await repoState(repo)
          if (state !== "ready") {
            context.ui.toast.show({
              title: "Config sync",
              message: "Config repo is not set up; run /config-sync-setup",
              variant: "info",
            })
            return
          }
          const { before, after } = await fetchRepo(repo)
          const fetched = after - before
          context.ui.toast.show({
            title: "Config fetch",
            message:
              fetched > 0
                ? `Fetched ↓${fetched} new commit${fetched === 1 ? "" : "s"} to pull`
                : "Already up to date",
            variant: "success",
          })
        } catch (error) {
          failed("Config fetch failed", error)
        }
      })

    const runSetup = async () => {
      try {
        if ((await repoState(repo)) !== "no-repo")
          return context.ui.toast.show({ message: "Config folder is already a git repository", variant: "info" })
        const mode = await context.ui.dialog.select({
          title: "Set up config sync",
          options: [
            { title: "Pull existing config", value: "existing", description: "This machine joins a repo you already push to" },
            { title: "Start new", value: "new", description: "Push this machine's config to a new, empty repo" },
          ],
        })
        if (!mode) return
        const url = (
          await context.ui.dialog.prompt({
            title: "Git remote URL",
            description: "Uses your normal git credentials (SSH key or credential helper).",
            placeholder: "git@example.com:you/opencode-config.git",
          })
        )?.trim()
        if (!url) return
        if (mode === "new") {
          await setupNew(repo, url, "initial import")
          context.ui.toast.show({ title: "Config sync", message: "Config pushed to the new repo ✓", variant: "success" })
          return
        }
        const result = await setupExisting(repo, url)
        context.ui.toast.show({
          title: "Config sync",
          message: result.backup
            ? `Remote config checked out. ${plural(result.moved.length, "local file")} moved to ${result.backup}/ (click to dismiss)`
            : "Remote config checked out ✓",
          variant: "success",
          duration: result.backup ? STICKY_MS : undefined,
        })
      } catch (error) {
        failed("Config sync setup failed", error)
      }
    }

    context.ui.slot({ append: "prompt.footer.status", render: () => <FooterStatus /> })
    context.ui.slot({ append: "sidebar.content", render: () => <SidebarStatus /> })
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "config-sync.sync",
          title: "Sync config repo (commit, pull --rebase, push)",
          group: "Config sync",
          palette: true,
          slash: { name: "config-sync" },
          run: () => runSync(),
        },
        {
          id: "config-sync.refresh",
          title: "Refresh config repo sync status",
          group: "Config sync",
          palette: true,
          slash: { name: "config-sync-refresh" },
          run: () => refresh(true),
        },
        {
          id: "config-sync.fetch",
          title: "Fetch config repo",
          group: "Config sync",
          palette: true,
          slash: { name: "config-sync-fetch" },
          run: () => runFetch(),
        },
        {
          id: "config-sync.setup",
          title: "Set up config repo sync",
          group: "Config sync",
          palette: true,
          slash: { name: "config-sync-setup" },
          run: () => exclusive(runSetup),
        },
      ],
    }))

    let debounce: ReturnType<typeof setTimeout> | undefined
    const onChange = (_event: string, file: string | Buffer | null) => {
      const path = String(file ?? "").replaceAll("\\", "/")
      if (IGNORED.some((pattern) => pattern.test(path))) return
      clearTimeout(debounce)
      debounce = setTimeout(() => void refresh(), WATCH_DEBOUNCE_MS)
    }
    let watcher: FSWatcher | undefined
    try {
      watcher = watch(repo, { recursive: true }, onChange)
    } catch {
      // Recursive watching is unsupported here; the timer and turn events still refresh.
    }

    const stopEvents = context.data.on("session.execution.succeeded", () => void refresh())
    const timer = setInterval(() => void refresh(), refreshMs)
    void refresh()

    return () => {
      disposed = true
      setView(undefined)
      stopEvents()
      clearInterval(timer)
      clearTimeout(debounce)
      watcher?.close()
    }
  },
})
