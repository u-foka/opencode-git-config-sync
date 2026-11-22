/** @jsxImportSource @opentui/solid */
import { TextAttributes, type TextareaRenderable } from "@opentui/core"
import { usePlugin } from "@opencode/plugin/tui"
import { createSignal, For, onMount } from "solid-js"

// The host's prompt is a single-row field, so a commit message with a body needs its own dialog. Enter breaks the line
// in the text field; Tab moves to the buttons, where Enter chooses; Ctrl+S commits from anywhere.
const FOCUS = ["edit", "commit", "cancel"] as const
type Focus = (typeof FOCUS)[number]

export const COMMIT_HINT = "enter new line · ctrl+s commit · tab buttons · esc cancel"

export function CommitDialog(props: {
  readonly title: string
  readonly description: string
  readonly value: string
  readonly onCommit: (message: string) => void
  readonly onCancel: () => void
}) {
  const context = usePlugin()
  const theme = context.theme.surface("dialog")
  const [active, setActive] = createSignal<Focus>("edit")
  let textarea: TextareaRenderable | undefined

  const commit = () => props.onCommit(textarea?.plainText ?? props.value)
  const focus = (next: Focus) => {
    setActive(next)
    if (next === "edit") textarea?.focus()
    else textarea?.blur()
  }
  const move = (step: number) => focus(FOCUS[(FOCUS.indexOf(active()) + step + FOCUS.length) % FOCUS.length])
  const onButtons = () => active() !== "edit"

  context.keymap.layer(() => ({
    mode: "modal",
    priority: 2,
    commands: [
      { bind: "tab", title: "Next field", group: "Commit dialog", run: () => move(1) },
      { bind: "shift+tab", title: "Previous field", group: "Commit dialog", run: () => move(-1) },
      { bind: "ctrl+s", title: "Commit", group: "Commit dialog", run: commit },
      {
        bind: "return",
        title: "Choose button",
        group: "Commit dialog",
        enabled: onButtons,
        run: () => (active() === "commit" ? commit() : props.onCancel()),
      },
      { bind: "left", title: "Previous button", group: "Commit dialog", enabled: onButtons, run: () => focus("commit") },
      { bind: "right", title: "Next button", group: "Commit dialog", enabled: onButtons, run: () => focus("cancel") },
    ],
  }))

  onMount(() => {
    context.ui.dialog.set({ size: "large" })
    // The host moves focus when it opens a dialog; take it back once that is done.
    setTimeout(() => {
      if (textarea && !textarea.isDestroyed && active() === "edit") textarea.focus()
    }, 1)
  })

  const buttons: { key: Focus; label: string; run: () => void }[] = [
    { key: "commit", label: "Commit", run: commit },
    { key: "cancel", label: "Cancel", run: () => props.onCancel() },
  ]

  return (
    <box paddingLeft={3} paddingRight={3} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
          {props.title}
        </text>
        <text fg={theme.text.muted} onMouseUp={() => props.onCancel()}>
          esc
        </text>
      </box>
      <text fg={theme.text.muted}>{props.description}</text>
      <textarea
        ref={(value: TextareaRenderable) => (textarea = value)}
        height={6}
        wrapMode="word"
        initialValue={props.value}
        onSubmit={() => textarea?.newLine()}
        onMouseDown={() => focus("edit")}
        textColor={theme.text.formfield.base}
        focusedTextColor={theme.text.formfield.base}
        backgroundColor={theme.background.formfield.base}
        focusedBackgroundColor={theme.background.formfield.base}
        cursorColor={theme.text.base}
      />
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text.muted}>{COMMIT_HINT}</text>
        <box flexDirection="row">
          <For each={buttons}>
            {(button) => (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={active() === button.key ? theme.background.action.primary.focused : undefined}
                onMouseUp={() => button.run()}
              >
                <text fg={active() === button.key ? theme.text.action.primary.focused : theme.text.muted}>
                  {button.label}
                </text>
              </box>
            )}
          </For>
        </box>
      </box>
    </box>
  )
}
