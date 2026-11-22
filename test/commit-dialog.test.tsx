import { afterEach, describe, expect, test } from "bun:test"
import { Plugin, PluginContextProvider } from "@opencode/plugin/tui"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { COMMIT_HINT, CommitDialog } from "../src/commit-dialog"

interface Command {
  readonly bind: string
  readonly enabled?: () => boolean
  readonly run: () => unknown
}

const THEME = {
  text: { base: "#ffffff", muted: "#808080", formfield: { base: "#ffffff" }, action: { primary: { focused: "#ffffff" } } },
  background: { formfield: { base: "#000000" }, action: { primary: { focused: "#0000ff" } } },
  surface: () => THEME,
}

function findTextarea(item: Renderable): TextareaRenderable | undefined {
  if (item instanceof TextareaRenderable) return item
  for (const child of item.getChildren()) {
    const found = findTextarea(child as Renderable)
    if (found) return found
  }
  return undefined
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function open(value = "update cli.json") {
  let commands: Command[] = []
  const results: (string | undefined)[] = []
  const context = {
    theme: THEME,
    ui: { dialog: { set: () => {} } },
    keymap: { layer: (layer: () => { commands: Command[] }) => (commands = layer().commands) },
  } as unknown as Plugin.Context
  const setup = await testRender(
    () => (
      <PluginContextProvider value={context}>
        <CommitDialog
          title="Commit config changes"
          description="1 staged file will be committed."
          value={value}
          onCommit={(message) => results.push(message)}
          onCancel={() => results.push(undefined)}
        />
      </PluginContextProvider>
    ),
    { width: 100, height: 20 },
  )
  cleanups.push(() => setup.dispose())
  await setup.renderOnce()
  const press = (key: string) => {
    const found = commands.find((entry) => entry.bind === key)
    if (!found) throw new Error(`no ${key} binding`)
    if (!(found.enabled?.() ?? true)) return false
    found.run()
    return true
  }
  return { setup, results, press, textarea: findTextarea(setup.renderer.root)! }
}

describe("commit dialog", () => {
  test("shows the message, the description and how to use it", async () => {
    const { setup } = await open()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Commit config changes")
    expect(frame).toContain("1 staged file will be committed.")
    expect(frame).toContain("update cli.json")
    expect(frame).toContain(COMMIT_HINT)
    expect(frame).toMatch(/Commit\s+Cancel/)
  })

  test("Enter in the text field breaks the line instead of submitting", async () => {
    const { textarea, results } = await open("subject")
    textarea.gotoBufferEnd()
    textarea.submit()
    textarea.insertText("body")
    expect(textarea.plainText).toBe("subject\nbody")
    expect(results).toEqual([])
  })

  test("Ctrl+S commits the edited text from the text field", async () => {
    const { textarea, results, press } = await open()
    textarea.setText("line one\nline two")
    press("ctrl+s")
    expect(results).toEqual(["line one\nline two"])
  })

  test("Enter only chooses once Tab has moved to the buttons", async () => {
    const { results, press } = await open()
    expect(press("return")).toBe(false)
    press("tab")
    press("return")
    expect(results).toEqual(["update cli.json"])
  })

  test("Tab reaches Cancel, and Shift+Tab and the arrows move back", async () => {
    const { results, press } = await open()
    press("tab")
    press("tab")
    press("return")
    press("left")
    press("return")
    press("right")
    press("shift+tab")
    press("return")
    press("shift+tab")
    expect(press("return")).toBe(false)
    expect(results).toEqual([undefined, "update cli.json", "update cli.json"])
  })
})
