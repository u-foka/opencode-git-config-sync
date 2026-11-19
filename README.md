# opencode-git-config-sync

Keep your global [opencode](https://opencode.ai) config in sync across machines with plain git, and always see
whether it is in sync, right in the TUI.

- **Live status** in the status bar (`cfg ↑1 ↓0 ●3`) and the session sidebar (changed files with line counts).
- **Outdated warning** when commits have waited more than 24h to be pushed or pulled, or uncommitted files are older
  than 24h: the status turns red, the sidebar shows `❗ OUTDATED!`, and a toast stays until you dismiss it (at most
  once a day per machine).
- **`/config-sync`**: commit (with a message you confirm), `pull --rebase`, update submodules, push. If the rebase does
  not apply cleanly it is aborted and left for you to resolve.
- **`/config-sync-setup`**: turn the config folder into a repo and push it, or adopt an existing remote on a new
  machine.
- **Your git, your host**: GitHub, GitLab, self-hosted, anything git can reach. No tokens, no `gh`, no hidden clone:
  the config folder itself is the repository.

## Install

Add the plugin to the global `cli.json` (`~/.config/opencode/cli.json`):

```json
{
  "plugins": ["opencode-git-config-sync"]
}
```

opencode installs the plugin once and does not update `cli.json` plugins automatically. Run `opencode plugin update`
to get the latest version. To pin a version instead, add it to the name; a pinned plugin stays on that version until
you change the number:

```json
{
  "plugins": ["opencode-git-config-sync@0.1.0"]
}
```

It is a TUI-only plugin. Since `cli.json` lives in the config folder, the plugin syncs to your other machines along
with everything else.

Requirements: `git` on `PATH`, and credentials that work without a prompt (an SSH key, or a credential helper for
HTTPS). The plugin never asks for passwords; git fails with an error instead.

## Commands

| Command                | What it does                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `/config-sync`         | Stage all changes, commit (asks for a message, with a proposed one), pull --rebase, push. Cancelling leaves the changes staged. |
| `/config-sync-refresh` | Refresh the status now, and show the outdated warning again if it applies.               |
| `/config-sync-setup`   | Set up the config folder: **Start new** or **Pull existing config**.                     |

All of them are also in the command palette under **Config sync**.

### Setup

- **Start new** (first machine): runs `git init`, adds a `.gitignore` for machine-local files (`service.json`,
  `*.local.json(c)`, `node_modules/`, OS junk), commits, and pushes to the URL you enter. The remote must be empty.
- **Pull existing config** (every other machine): fetches the remote and checks it out. Local files that the remote
  also has (there will be some, at least `cli.json`) are moved to `.config-sync-backup-<date>/` first, so you can merge
  anything you want to keep. The backup folder is ignored by git.

If a setup step fails (wrong URL, missing credentials, push rejected, checkout conflict), the setup is undone: the new
`.git` is removed, and the `.gitignore` or the backed-up files are restored, so you can simply run it again.

If the config folder is not a repository, the plugin suggests setup once a day.

## How it works

- The status refreshes when files in the config folder change (recursive file watcher), after every model turn, and
  every 5 minutes.
- It runs `git fetch` at most once per 24h. It never pulls or pushes on its own.
- Submodules are updated (`git submodule update --init --recursive`) after a pull.
- A submodule that moved to a new commit counts as a change: `/config-sync` commits the new pointer like any other
  file. The push uses `--recurse-submodules=check`, so it refuses to publish a pointer whose commit is not on the
  submodule's remote yet; push the submodule first.
- Uncommitted work inside a submodule is never committed or pushed, and does not count as an uncommitted file; the
  sidebar lists such submodules in red. `/config-sync` asks whether to ignore it and sync the rest, or cancel.
- Per-machine settings: keep them in git-ignored files such as `*.local.json`.

## Options

```json
{
  "plugins": [
    {
      "package": "opencode-git-config-sync",
      "options": {
        "repo": "~/.config/opencode",
        "staleHours": 24,
        "refreshMinutes": 5,
        "maxFiles": 3,
        "label": "cfg"
      }
    }
  ]
}
```

| Option           | Default                              | Meaning                                                    |
| ---------------- | ------------------------------------ | ---------------------------------------------------------- |
| `repo`           | `OPENCODE_CONFIG_DIR`, else XDG path | The config folder to track.                                |
| `staleHours`     | `24`                                 | Age after which changes count as outdated; fetch interval. |
| `refreshMinutes` | `5`                                  | Fallback refresh interval.                                 |
| `maxFiles`       | `3`                                  | Changed files listed in the sidebar.                       |
| `label`          | `cfg`                                | Status bar label.                                          |

## Compared to other sync plugins

There are several config sync tools for opencode. This one is deliberately small:

- [`opencode-synced`](https://github.com/iHildy/opencode-synced) and its forks sync config, secrets, sessions and
  prompt history through a separate clone on GitHub, auto-sync at startup and support per-machine override merging.
  Choose it if you want all of that. On opencode V2 its sync runs through an agent tool, and it shows no live status.
- [`opencode-github-sync`](https://github.com/doomsday616/opencode-github-sync) syncs config, data and sessions through
  GitHub with a plugin and a CLI.
- [`opencode-sync-config`](https://github.com/guilhermelowa/opencode-sync-config) also uses the config folder as the
  repo, but commits and pushes automatically on exit.
- Standalone tools such as [`GareArc/opencode-sync`](https://github.com/GareArc/opencode-sync) and
  [`theseyan/opencode-sync`](https://github.com/theseyan/opencode-sync) work outside opencode.

`opencode-git-config-sync` never commits or pushes without you, works with any git host, and keeps the state visible
all the time.

## Development

The checks run with [bun](https://bun.sh): `bun install`, then `bun run check` (type check and tests). Without a local
bun, `./scripts/docker.sh` runs the same in the bun image CI uses (pass a command to run something else, e.g.
`./scripts/docker.sh bun test test/git.test.ts`).

- `test/git.test.ts` drives real git repositories in a temp folder (a bare repo stands in for the remote): status,
  submodules, sync, rebase conflicts, and setup including its undo.
- `test/tui.test.tsx` runs the plugin against a fake opencode context and renders the sidebar and status bar with
  opentui's test renderer, checking the text and colors, and the `/config-sync` dialogs.

`npm publish` runs the checks first (`prepublishOnly`).

## License

[Apache-2.0](LICENSE)
