// @bun
// src/tui.tsx
import { createTextNode as _$createTextNode2 } from "@opentui/solid";
import { insertNode as _$insertNode2 } from "@opentui/solid";
import { setProp as _$setProp2 } from "@opentui/solid";
import { effect as _$effect2 } from "@opentui/solid";
import { insert as _$insert2 } from "@opentui/solid";
import { createElement as _$createElement2 } from "@opentui/solid";
import { createComponent as _$createComponent2 } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { watch } from "fs";
import { Plugin, usePlugin as usePlugin2 } from "@opencode/plugin/tui";
import { createSignal as createSignal2, For as For2, Match, Show, Switch } from "solid-js";

// src/git.ts
import { execFile } from "child_process";
import { appendFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import { basename, dirname, join, sep } from "path";
var DEFAULT_GITIGNORE = `node_modules/

# local service credentials
service.json

# secrets
.env
.env.*
*.pem
*.key

# machine-specific overrides
*.local.json
*.local.jsonc

# opencode-git-config-sync backups
.config-sync-backup-*/

# OS junk
.DS_Store
Thumbs.db
desktop.ini
`;
function git(repo, args, options = {}) {
  return new Promise((done, fail) => execFile("git", ["-C", repo, ...args], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...options.env }
  }, (error, stdout, stderr) => error ? fail(new Error(error.killed ? `git ${args[0]} timed out` : redact((stderr || error.message).trim()))) : done(stdout)));
}
var BACKGROUND_TIMEOUT_MS = 60000;
async function batchSsh(repo) {
  if (process.env.GIT_SSH)
    return {};
  const base = process.env.GIT_SSH_COMMAND || await git(repo, ["config", "--get", "core.sshCommand"]).then((out) => out.trim(), () => "") || "ssh";
  return { GIT_SSH_COMMAND: `${base} -o BatchMode=yes` };
}
var succeeds = (promise) => promise.then(() => true, () => false);
var age = async (path) => {
  try {
    return Date.now() - (await stat(path)).mtimeMs;
  } catch {
    return;
  }
};
var exists = async (path) => await age(path) !== undefined;
var redact = (text) => text.replace(/(https?:\/\/)[^/@\s]+@/gi, "$1***@").replace(/(\w+:\/\/[^/@:\s]*):[^/@\s]+@/g, "$1:***@");
var printable = (text, keepLines = false) => text.replace(keepLines ? /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g : /[\x00-\x1f\x7f-\x9f]/g, "\uFFFD");
var SECRET_FILES = [
  [/^\.env(\..+)?$/, "env file"],
  [/\.(pem|key|p12|pfx)$/i, "key file"],
  [/^id_(rsa|dsa|ecdsa|ed25519)$/, "SSH key"],
  [/^auth\.json$/, "credentials file"]
];
var SECRET_TEXT = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\b(sk-[\w-]{20,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16})/, "token"]
];
var ASSIGNMENT = /["']?([\w.-]+)["']?\s*[:=]\s*["']?([^"'\s,}]+)/g;
var SECRET_KEY = [/(^|[_.-])(api[_-]?key|token|secret|pass|passwd|password)$/i, /[a-z](ApiKey|Token|Secret|Pass|Passwd|Password)$/];
var PLACEHOLDER = /^(\{(env|file):|\$|<|true$|false$|null$|\d+$)/;
function secretInLine(line) {
  for (const [pattern, reason] of SECRET_TEXT)
    if (pattern.test(line))
      return reason;
  for (const [, key, value] of line.matchAll(ASSIGNMENT))
    if (SECRET_KEY.some((pattern) => pattern.test(key)) && !PLACEHOLDER.test(value))
      return `${key} value`;
  return;
}
async function stagedSecrets(repo) {
  const found = new Set;
  const names = await git(repo, ["diff", "--cached", "--name-only", "--diff-filter=d", "--no-renames", "-z"]);
  for (const path of names.split("\x00").filter(Boolean))
    for (const [pattern, reason] of SECRET_FILES)
      if (pattern.test(basename(path)))
        found.add(`${path} (${reason})`);
  const diff = await git(repo, ["-c", "core.quotePath=false", "diff", "--cached", "--no-renames", "--no-color", "--no-ext-diff", "-U0"]);
  let path = "";
  for (const line of diff.split(`
`)) {
    if (line.startsWith("+++ "))
      path = line.slice(4).replace(/^b\//, "");
    else if (line.startsWith("+")) {
      const reason = secretInLine(line.slice(1));
      if (reason)
        found.add(`${path} (${reason})`);
    }
  }
  return [...found];
}
function unsafePath(path) {
  const parts = path.split(process.platform === "win32" ? /[\\/]/ : "/");
  return path.startsWith("/") || /^[a-z]:/i.test(path) || parts.some((part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git");
}
async function insideRepo(repo, path) {
  const [root, parent] = await Promise.all([realpath(repo), realpath(dirname(path))]);
  return parent === root || parent.startsWith(root + sep);
}
function configDir(override) {
  if (override)
    return override.replace(/^~(?=$|[\\/])/, homedir());
  if (process.env.OPENCODE_CONFIG_DIR)
    return process.env.OPENCODE_CONFIG_DIR;
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
}
async function repoState(repo) {
  const inside = await git(repo, ["rev-parse", "--show-toplevel"]).then((out) => out.trim(), () => {
    return;
  });
  if (!inside || !await sameDir(inside, repo))
    return "no-repo";
  return await succeeds(git(repo, ["rev-parse", "--abbrev-ref", "@{u}"])) ? "ready" : "no-upstream";
}
async function sameDir(left, right) {
  const [a, b] = await Promise.all([left, right].map((path) => stat(path).catch(() => {
    return;
  })));
  return !!a && !!b && a.ino === b.ino && a.dev === b.dev;
}
async function fetchIfStale(repo, staleMs) {
  const gitDir = (await git(repo, ["rev-parse", "--absolute-git-dir"])).trim();
  const fetchAge = await age(join(gitDir, "FETCH_HEAD"));
  if (fetchAge !== undefined && fetchAge < staleMs)
    return;
  await git(repo, ["fetch", "--quiet"], { timeout: BACKGROUND_TIMEOUT_MS, env: await batchSsh(repo) }).catch(() => {});
}
async function oldestCommitAge(repo, range) {
  const out = await git(repo, ["log", "--format=%ct", range]);
  const times = out.split(`
`).filter(Boolean).map(Number);
  return times.length ? Date.now() - Math.min(...times) * 1000 : 0;
}
async function countLines(path) {
  try {
    const text = await readFile(path, "utf8");
    if (text.includes("\x00"))
      return;
    return text.length === 0 ? 0 : text.split(`
`).length - (text.endsWith(`
`) ? 1 : 0);
  } catch {
    return;
  }
}
async function changedFiles(repo) {
  const status = await git(repo, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
  const entries = status.split("\x00");
  const files = [];
  const dirtySubmodules = [];
  for (let i = 0;i < entries.length; i++) {
    const entry = entries[i];
    if (!entry)
      continue;
    const kind = entry[0];
    if (kind === "?") {
      files.push({ code: "??", path: entry.slice(2), submodule: false });
      continue;
    }
    if (kind !== "1" && kind !== "2" && kind !== "u")
      continue;
    const fields = entry.split(" ");
    const pathIndex = kind === "1" ? 8 : kind === "2" ? 9 : 10;
    const path = fields.slice(pathIndex).join(" ");
    const xy = fields[1];
    const sub = fields[2];
    if (kind === "2")
      i++;
    if (sub.startsWith("S") && (sub[2] === "M" || sub[3] === "U"))
      dirtySubmodules.push(path);
    if (sub.startsWith("S") && sub[1] !== "C" && xy === ".M")
      continue;
    const code = xy.replaceAll(".", " ");
    files.push({ code: code.trim() || code, path, submodule: sub.startsWith("S") });
  }
  const numstat = new Map;
  if (await succeeds(git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]))) {
    const out = await git(repo, ["diff", "--numstat", "-z", "--no-renames", "HEAD"]);
    for (const row of out.split("\x00")) {
      const [added, removed, path] = row.split("\t");
      if (path === undefined)
        continue;
      numstat.set(path, [added === "-" ? undefined : Number(added), removed === "-" ? undefined : Number(removed)]);
    }
  }
  const counted = await Promise.all(files.map(async ({ code, path, submodule }) => {
    if (submodule)
      return { code, path, added: undefined, removed: undefined, submodule };
    if (code === "??")
      return { code, path, added: await countLines(join(repo, path)), removed: 0, submodule };
    const [added, removed] = numstat.get(path) ?? [undefined, undefined];
    return { code, path, added, removed, submodule };
  }));
  return { files: counted, dirtySubmodules };
}
async function readStatus(repo, staleMs, fetchMs = staleMs) {
  await fetchIfStale(repo, fetchMs);
  const [left, right] = (await git(repo, ["rev-list", "--left-right", "--count", "HEAD...@{u}"])).trim().split(/\s+/);
  const ahead = Number(left) || 0;
  const behind = Number(right) || 0;
  const hours = Math.round(staleMs / 3600000);
  const reasons = [];
  if (ahead && await oldestCommitAge(repo, "@{u}..HEAD") > staleMs)
    reasons.push(`${ahead} to push for over ${hours}h`);
  if (behind && await oldestCommitAge(repo, "HEAD..@{u}") > staleMs)
    reasons.push(`${behind} to pull for over ${hours}h`);
  const { files, dirtySubmodules } = await changedFiles(repo);
  const unpushed = await unpushedSubmodules(repo);
  const ages = await Promise.all(files.map((file) => age(join(repo, file.path))));
  const stale = ages.filter((value) => value !== undefined && value > staleMs).length;
  if (stale)
    reasons.push(`${stale} uncommitted file${stale === 1 ? "" : "s"} older than ${hours}h`);
  return { ahead, behind, files, dirtySubmodules, unpushedSubmodules: unpushed, outdated: reasons.length > 0, reasons };
}
var unpushedMessage = (paths) => `${paths.join(", ")} ${paths.length === 1 ? "has" : "have"} commits that are not pushed; push the submodule first`;
async function unpushedSubmodules(repo) {
  const entries = (await git(repo, ["ls-files", "--stage", "-z"])).split("\x00").filter((entry) => entry.startsWith("160000 "));
  const paths = entries.map((entry) => entry.slice(entry.indexOf("\t") + 1));
  const unpushed = await Promise.all(paths.map(async (path) => {
    const sub = join(repo, path);
    if (!await exists(join(sub, ".git")))
      return false;
    const remote = await git(sub, ["branch", "--remotes", "--contains", "HEAD"]).catch(() => "");
    return remote.trim() === "";
  }));
  return paths.filter((_, index) => unpushed[index]);
}
function proposeMessage(files) {
  const groups = new Map;
  for (const file of files) {
    const parts = file.path.split("/");
    const target = parts.length > 2 ? parts.slice(0, 2).join("/") : file.path;
    const verb = file.code === "??" || file.code === "A" ? "add" : file.code === "D" ? "remove" : "update";
    groups.set(verb, (groups.get(verb) ?? new Set).add(target));
  }
  const phrases = [];
  for (const verb of ["update", "add", "remove"]) {
    const targets = [...groups.get(verb) ?? []];
    if (!targets.length)
      continue;
    const listed = targets.slice(0, 3).join(", ");
    phrases.push(`${verb} ${listed}${targets.length > 3 ? ` (+${targets.length - 3} more)` : ""}`);
  }
  return phrases.join("; ") || "config updates";
}
async function updateSubmodules(repo) {
  if (!await exists(join(repo, ".gitmodules")))
    return;
  await git(repo, ["submodule", "sync", "--recursive", "--quiet"]);
  await git(repo, ["submodule", "update", "--init", "--recursive", "--quiet"]);
}
async function stageAll(repo) {
  await git(repo, ["add", "--all"]);
}
async function sync(repo, message, onStep) {
  if (await repoState(repo) !== "ready")
    throw new Error("Config repo is not set up; run /config-sync-setup");
  const unpushed = await unpushedSubmodules(repo);
  if (unpushed.length)
    throw new Error(unpushedMessage(unpushed));
  if (message !== undefined) {
    onStep("commit");
    await git(repo, ["commit", "--quiet", "-m", message]);
  }
  await git(repo, ["fetch", "--quiet"]);
  const [left, right] = (await git(repo, ["rev-list", "--left-right", "--count", "HEAD...@{u}"])).trim().split(/\s+/);
  const pushed = Number(left) || 0;
  const pulled = Number(right) || 0;
  onStep("pull");
  try {
    await git(repo, ["pull", "--rebase", "--quiet", "--no-recurse-submodules"]);
  } catch (error) {
    const gitDir = (await git(repo, ["rev-parse", "--absolute-git-dir"])).trim();
    const rebasing = await exists(join(gitDir, "rebase-merge")) || await exists(join(gitDir, "rebase-apply"));
    if (rebasing)
      await git(repo, ["rebase", "--abort"]).catch(() => {});
    throw new Error(`Pull --rebase failed${rebasing ? " (rebase aborted, your commit is kept)" : ""}: ${error.message}`);
  }
  onStep("submodules");
  await updateSubmodules(repo);
  onStep("push");
  await git(repo, ["push", "--quiet", "--recurse-submodules=check"]);
  return { pushed, pulled };
}
async function fetchRepo(repo) {
  if (await repoState(repo) !== "ready")
    throw new Error("Config repo is not set up; run /config-sync-setup");
  const behind = async () => {
    try {
      return Number((await git(repo, ["rev-list", "--count", "HEAD..@{u}"])).trim()) || 0;
    } catch {
      return 0;
    }
  };
  const before = await behind();
  await git(repo, ["fetch", "--quiet"]);
  const after = await behind();
  return { before, after };
}
async function remoteBranch(repo, url) {
  const heads = (await git(repo, ["ls-remote", "--heads", "--end-of-options", url])).split(`
`).map((line) => line.split("\trefs/heads/")[1]).filter((name) => !!name);
  if (!heads.length)
    return;
  const symref = (await git(repo, ["ls-remote", "--symref", "--end-of-options", url, "HEAD"])).match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1];
  return [symref, "main", "master"].find((name) => name && heads.includes(name)) ?? heads[0];
}
async function ensureGitignore(repo) {
  const path = join(repo, ".gitignore");
  const current = await readFile(path, "utf8").catch(() => {
    return;
  });
  if (current === undefined)
    return writeFile(path, DEFAULT_GITIGNORE);
  const lines = new Set(current.split(/\r?\n/));
  const missing = DEFAULT_GITIGNORE.split(`
`).filter((line) => line && !line.startsWith("#") && !lines.has(line));
  if (missing.length)
    await appendFile(path, `${current.endsWith(`
`) ? "" : `
`}${missing.join(`
`)}
`);
}
async function undoSetup(repo, error, undo) {
  const message = error.message;
  try {
    await undo();
    await rm(join(repo, ".git"), { recursive: true, force: true });
  } catch (undoError) {
    throw new Error(`${message} (undoing the setup also failed: ${undoError.message})`);
  }
  throw new Error(`${message} (setup undone, the config folder is as before)`);
}
async function setupNew(repo, url, message, confirmSecrets = async () => true) {
  if (await repoState(repo) !== "no-repo")
    throw new Error("Config directory is already a git repository");
  if (await remoteBranch(repo, url))
    throw new Error("Remote is not empty; use \u201CPull existing config\u201D instead");
  const gitignore = join(repo, ".gitignore");
  const originalGitignore = await readFile(gitignore, "utf8").catch(() => {
    return;
  });
  const restoreGitignore = () => originalGitignore === undefined ? rm(gitignore, { force: true }) : writeFile(gitignore, originalGitignore);
  try {
    await git(repo, ["init", "--quiet"]);
    await ensureGitignore(repo);
    await git(repo, ["add", "--all"]);
    const found = await stagedSecrets(repo);
    if (found.length && !await confirmSecrets(found)) {
      await restoreGitignore();
      await rm(join(repo, ".git"), { recursive: true, force: true });
      return false;
    }
    await git(repo, ["commit", "--quiet", "-m", message]);
    await git(repo, ["remote", "add", "--end-of-options", "origin", url]);
    await git(repo, ["push", "--quiet", "-u", "origin", "HEAD"]);
  } catch (error) {
    await undoSetup(repo, error, restoreGitignore);
  }
  return true;
}
async function setupExisting(repo, url) {
  if (await repoState(repo) !== "no-repo")
    throw new Error("Config directory is already a git repository");
  const branch = await remoteBranch(repo, url);
  if (!branch)
    throw new Error("Remote is empty; use \u201CStart new\u201D instead");
  let backup;
  const moved = [];
  try {
    await git(repo, ["init", "--quiet", `--initial-branch=${branch}`]);
    await git(repo, ["remote", "add", "--end-of-options", "origin", url]);
    await git(repo, ["-c", "transfer.fsckObjects=true", "fetch", "--quiet", "origin"]);
    const remoteFiles = (await git(repo, ["ls-tree", "-r", "-z", "--name-only", `origin/${branch}`])).split("\x00").filter(Boolean);
    const unsafe = remoteFiles.find(unsafePath);
    if (unsafe)
      throw new Error(`Remote has an unsafe path: ${unsafe}`);
    const clashing = [];
    for (const path of remoteFiles)
      if (await lstat(join(repo, path)).then(() => true, () => false))
        clashing.push(path);
    for (const path of clashing)
      if (!await insideRepo(repo, join(repo, path)))
        throw new Error(`${path} is behind a symbolic link that leaves the config folder`);
    if (clashing.length) {
      backup = `.config-sync-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      const gitDir = (await git(repo, ["rev-parse", "--absolute-git-dir"])).trim();
      await mkdir(join(gitDir, "info"), { recursive: true });
      await appendFile(join(gitDir, "info", "exclude"), `
.config-sync-backup-*/
`);
      for (const path of clashing) {
        const target = join(repo, backup, path);
        await mkdir(dirname(target), { recursive: true });
        await rename(join(repo, path), target);
        moved.push(path);
      }
    }
    await git(repo, ["checkout", "--quiet", "-B", branch, "--track", `origin/${branch}`]);
  } catch (error) {
    await undoSetup(repo, error, async () => {
      if (!backup)
        return;
      for (const path of moved) {
        await rm(join(repo, path), { recursive: true, force: true });
        await rename(join(repo, backup, path), join(repo, path));
      }
      await rm(join(repo, backup), { recursive: true, force: true });
    });
  }
  await updateSubmodules(repo);
  return { backup, moved };
}

// src/commit-dialog.tsx
import { effect as _$effect } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { use as _$use } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { TextAttributes } from "@opentui/core";
import { usePlugin } from "@opencode/plugin/tui";
import { createSignal, For, onMount } from "solid-js";
var FOCUS = ["edit", "commit", "cancel"];
function CommitDialog(props) {
  const context = usePlugin();
  const theme = context.theme.surface("dialog");
  const [active, setActive] = createSignal("edit");
  let textarea;
  const commit = () => props.onCommit(textarea?.plainText ?? props.value);
  const focus = (next) => {
    setActive(next);
    if (next === "edit")
      textarea?.focus();
    else
      textarea?.blur();
  };
  const move = (step) => focus(FOCUS[(FOCUS.indexOf(active()) + step + FOCUS.length) % FOCUS.length]);
  const onButtons = () => active() !== "edit";
  context.keymap.layer(() => ({
    mode: "modal",
    priority: 2,
    commands: [{
      bind: "tab",
      title: "Next field",
      group: "Commit dialog",
      run: () => move(1)
    }, {
      bind: "shift+tab",
      title: "Previous field",
      group: "Commit dialog",
      run: () => move(-1)
    }, {
      bind: "ctrl+s",
      title: "Commit",
      group: "Commit dialog",
      run: commit
    }, {
      bind: "return",
      title: "Choose button",
      group: "Commit dialog",
      enabled: onButtons,
      run: () => active() === "commit" ? commit() : props.onCancel()
    }, {
      bind: "left",
      title: "Previous button",
      group: "Commit dialog",
      enabled: onButtons,
      run: () => focus("commit")
    }, {
      bind: "right",
      title: "Next button",
      group: "Commit dialog",
      enabled: onButtons,
      run: () => focus("cancel")
    }]
  }));
  onMount(() => {
    context.ui.dialog.set({
      size: "large"
    });
    setTimeout(() => {
      if (textarea && !textarea.isDestroyed && active() === "edit")
        textarea.focus();
    }, 1);
  });
  const buttons = [{
    key: "commit",
    label: "Commit",
    run: commit
  }, {
    key: "cancel",
    label: "Cancel",
    run: () => props.onCancel()
  }];
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$3 = _$createElement("text"), _el$4 = _$createElement("text"), _el$6 = _$createElement("text"), _el$7 = _$createElement("textarea"), _el$8 = _$createElement("box"), _el$9 = _$createElement("text"), _el$1 = _$createElement("box");
    _$insertNode(_el$, _el$2);
    _$insertNode(_el$, _el$6);
    _$insertNode(_el$, _el$7);
    _$insertNode(_el$, _el$8);
    _$setProp(_el$, "paddingLeft", 3);
    _$setProp(_el$, "paddingRight", 3);
    _$setProp(_el$, "paddingBottom", 1);
    _$setProp(_el$, "gap", 1);
    _$insertNode(_el$2, _el$3);
    _$insertNode(_el$2, _el$4);
    _$setProp(_el$2, "flexDirection", "row");
    _$setProp(_el$2, "justifyContent", "space-between");
    _$insert(_el$3, () => props.title);
    _$insertNode(_el$4, _$createTextNode(`esc`));
    _$setProp(_el$4, "onMouseUp", () => props.onCancel());
    _$insert(_el$6, () => props.description);
    _$use((value) => textarea = value, _el$7);
    _$setProp(_el$7, "height", 6);
    _$setProp(_el$7, "wrapMode", "word");
    _$setProp(_el$7, "onSubmit", () => textarea?.newLine());
    _$setProp(_el$7, "onMouseDown", () => focus("edit"));
    _$insertNode(_el$8, _el$9);
    _$insertNode(_el$8, _el$1);
    _$setProp(_el$8, "flexDirection", "row");
    _$setProp(_el$8, "justifyContent", "space-between");
    _$insertNode(_el$9, _$createTextNode(`enter new line \xB7 ctrl+s commit \xB7 tab buttons \xB7 esc cancel`));
    _$setProp(_el$1, "flexDirection", "row");
    _$insert(_el$1, _$createComponent(For, {
      each: buttons,
      children: (button) => (() => {
        var _el$10 = _$createElement("box"), _el$11 = _$createElement("text");
        _$insertNode(_el$10, _el$11);
        _$setProp(_el$10, "paddingLeft", 1);
        _$setProp(_el$10, "paddingRight", 1);
        _$setProp(_el$10, "onMouseUp", () => button.run());
        _$insert(_el$11, () => button.label);
        _$effect((_p$) => {
          var _v$10 = active() === button.key ? theme.background.action.primary.focused : undefined, _v$11 = active() === button.key ? theme.text.action.primary.focused : theme.text.muted;
          _v$10 !== _p$.e && (_p$.e = _$setProp(_el$10, "backgroundColor", _v$10, _p$.e));
          _v$11 !== _p$.t && (_p$.t = _$setProp(_el$11, "fg", _v$11, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$10;
      })()
    }));
    _$effect((_p$) => {
      var _v$ = TextAttributes.BOLD, _v$2 = theme.text.base, _v$3 = theme.text.muted, _v$4 = theme.text.muted, _v$5 = props.value, _v$6 = theme.text.formfield.base, _v$7 = theme.text.formfield.base, _v$8 = theme.background.formfield.base, _v$9 = theme.background.formfield.base, _v$0 = theme.text.base, _v$1 = theme.text.muted;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$3, "attributes", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$3, "fg", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp(_el$4, "fg", _v$3, _p$.a));
      _v$4 !== _p$.o && (_p$.o = _$setProp(_el$6, "fg", _v$4, _p$.o));
      _v$5 !== _p$.i && (_p$.i = _$setProp(_el$7, "initialValue", _v$5, _p$.i));
      _v$6 !== _p$.n && (_p$.n = _$setProp(_el$7, "textColor", _v$6, _p$.n));
      _v$7 !== _p$.s && (_p$.s = _$setProp(_el$7, "focusedTextColor", _v$7, _p$.s));
      _v$8 !== _p$.h && (_p$.h = _$setProp(_el$7, "backgroundColor", _v$8, _p$.h));
      _v$9 !== _p$.r && (_p$.r = _$setProp(_el$7, "focusedBackgroundColor", _v$9, _p$.r));
      _v$0 !== _p$.d && (_p$.d = _$setProp(_el$7, "cursorColor", _v$0, _p$.d));
      _v$1 !== _p$.l && (_p$.l = _$setProp(_el$9, "fg", _v$1, _p$.l));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined,
      s: undefined,
      h: undefined,
      r: undefined,
      d: undefined,
      l: undefined
    });
    return _el$;
  })();
}

// src/tui.tsx
var HOUR_MS = 60 * 60 * 1000;
var STICKY_MS = 2147483647;
var WATCH_DEBOUNCE_MS = 500;
var IGNORED = [/^\.git\/(objects|logs)\//, /\.lock$/, /(^|\/)node_modules(\/|$)/];
var [view, setView] = createSignal2();
var [settings, setSettings] = createSignal2({
  maxFiles: 3,
  label: "cfg"
});
var plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
var lineCounts = (file) => file.submodule ? "" : [file.added ? `+${file.added}` : "", file.removed ? `\u2212${file.removed}` : ""].filter(Boolean).join(" ") || (file.added === undefined ? "bin" : "");
function rows(status) {
  const dirty = new Set(status.dirtySubmodules);
  const unpushed = new Set(status.unpushedSubmodules);
  const listed = new Set(status.files.map((file) => file.path));
  const note = (path) => unpushed.has(path) ? " not pushed" : "";
  const extra = [...new Set([...status.dirtySubmodules, ...status.unpushedSubmodules])].filter((path) => !listed.has(path));
  return [
    ...status.files.map((file) => ({
      text: `  ${file.code.padEnd(2)} ${printable(file.path)} ${lineCounts(file)}`.trimEnd() + note(file.path),
      warn: dirty.has(file.path) || unpushed.has(file.path)
    })),
    ...extra.map((path) => ({
      text: `${unpushed.has(path) ? "\u2757" : "  "}${dirty.has(path) ? "m " : "\u2191 "} ${printable(path)}${note(path)}`,
      warn: true
    }))
  ];
}
function summary(status) {
  const parts = [status.ahead ? `\u2191${status.ahead}` : "", status.behind ? `\u2193${status.behind}` : "", status.files.length ? `\u25CF${status.files.length}` : ""];
  const text = parts.filter(Boolean).join(" ");
  return `${settings().label} ${text || "\u2713"}`;
}
function FooterStatus() {
  const context = usePlugin2();
  return _$createComponent2(Switch, {
    get children() {
      return [_$createComponent2(Match, {
        get when() {
          return _$memo(() => view()?.state === "ready")() && view().status;
        },
        children: (status) => (() => {
          var _el$2 = _$createElement2("text");
          _$insert2(_el$2, () => (status().outdated ? "\u2757 " : "") + summary(status()));
          _$effect2((_$p) => _$setProp2(_el$2, "fg", status().outdated ? context.theme.text.feedback.error.base : context.theme.text.muted, _$p));
          return _el$2;
        })()
      }), _$createComponent2(Match, {
        get when() {
          return view();
        },
        get children() {
          var _el$ = _$createElement2("text");
          _$insert2(_el$, () => `${settings().label} not synced`);
          _$effect2((_$p) => _$setProp2(_el$, "fg", context.theme.text.muted, _$p));
          return _el$;
        }
      })];
    }
  });
}
function SidebarStatus() {
  const context = usePlugin2();
  return _$createComponent2(Switch, {
    get children() {
      return [_$createComponent2(Match, {
        get when() {
          return _$memo(() => view()?.state === "ready")() && view().status;
        },
        children: (status) => {
          const all = () => rows(status());
          const shown = () => all().slice(0, settings().maxFiles);
          const more = () => all().length - shown().length;
          return (() => {
            var _el$3 = _$createElement2("box"), _el$6 = _$createElement2("text"), _el$7 = _$createTextNode2(`Config `);
            _$insertNode2(_el$3, _el$6);
            _$setProp2(_el$3, "flexDirection", "column");
            _$insert2(_el$3, _$createComponent2(Show, {
              get when() {
                return status().outdated;
              },
              get children() {
                var _el$4 = _$createElement2("text");
                _$insertNode2(_el$4, _$createTextNode2(`\u2757 OUTDATED!`));
                _$effect2((_$p) => _$setProp2(_el$4, "fg", context.theme.text.feedback.error.base, _$p));
                return _el$4;
              }
            }), _el$6);
            _$insertNode2(_el$6, _el$7);
            _$insert2(_el$6, (() => {
              var _c$ = _$memo(() => !!(status().ahead || status().behind));
              return () => _c$() ? `\u2191${status().ahead} to push \xB7 \u2193${status().behind} to pull` : _$memo(() => !!(status().files.length || status().dirtySubmodules.length || status().unpushedSubmodules.length))() ? status().files.length === 0 && (status().dirtySubmodules.length > 0 || status().unpushedSubmodules.length > 0) ? "needs some love \u2764\uFE0F" : "" : "in sync \u2713";
            })(), null);
            _$insert2(_el$3, _$createComponent2(Show, {
              get when() {
                return status().files.length;
              },
              get children() {
                var _el$8 = _$createElement2("text");
                _$insert2(_el$8, () => `${status().files.length} uncommitted`);
                _$effect2((_$p) => _$setProp2(_el$8, "fg", context.theme.text.muted, _$p));
                return _el$8;
              }
            }), null);
            _$insert2(_el$3, _$createComponent2(For2, {
              get each() {
                return shown();
              },
              children: (row) => (() => {
                var _el$0 = _$createElement2("text");
                _$insert2(_el$0, () => row.text);
                _$effect2((_$p) => _$setProp2(_el$0, "fg", row.warn ? context.theme.text.feedback.error.base : context.theme.text.muted, _$p));
                return _el$0;
              })()
            }), null);
            _$insert2(_el$3, _$createComponent2(Show, {
              get when() {
                return more() > 0;
              },
              get children() {
                var _el$9 = _$createElement2("text");
                _$insert2(_el$9, () => `  \u2026 ${plural(more(), "more file")} changed`);
                _$effect2((_$p) => _$setProp2(_el$9, "fg", context.theme.text.muted, _$p));
                return _el$9;
              }
            }), null);
            _$effect2((_$p) => _$setProp2(_el$6, "fg", context.theme.text.base, _$p));
            return _el$3;
          })();
        }
      }), _$createComponent2(Match, {
        get when() {
          return view();
        },
        children: (current) => (() => {
          var _el$1 = _$createElement2("text");
          _$insert2(_el$1, () => current().state === "no-repo" ? "Config not in git \xB7 /config-sync-setup" : "Config repo has no upstream");
          _$effect2((_$p) => _$setProp2(_el$1, "fg", context.theme.text.muted, _$p));
          return _el$1;
        })()
      })];
    }
  });
}
var tui_default = Plugin.define({
  id: "opencode-git-config-sync",
  setup(context) {
    const options = context.options ?? {};
    const repo = configDir(options.repo);
    const staleMs = (options.staleHours ?? 24) * HOUR_MS;
    const refreshMs = (options.refreshMinutes ?? 5) * 60 * 1000;
    const fetchMs = (options.fetchMinutes ?? 60) * 60 * 1000;
    setSettings({
      maxFiles: options.maxFiles ?? 3,
      label: options.label ?? "cfg"
    });
    const [reminders, setReminders] = context.storage.store("reminders", {
      initial: {
        outdated: 0,
        setup: 0
      }
    });
    let running = false;
    let pending = false;
    let busy = false;
    let idle = Promise.resolve();
    let disposed = false;
    const show = (next) => {
      if (!disposed)
        setView(next);
    };
    const remind = async (kind, force, show) => {
      if (!force && Date.now() - reminders[kind] < staleMs)
        return;
      await setReminders((draft) => {
        draft[kind] = Date.now();
      });
      show();
    };
    const refresh = async (force = false) => {
      if (busy) {
        if (force)
          context.ui.toast.show({
            message: "Config sync is running; the status refreshes when it finishes",
            variant: "info"
          });
        return;
      }
      if (running) {
        pending = true;
        if (force)
          context.ui.toast.show({
            message: "A config status check is already running; refreshing again after it",
            variant: "info"
          });
        return;
      }
      running = true;
      let settle = () => {};
      idle = new Promise((resolve) => settle = resolve);
      try {
        const state = await repoState(repo);
        if (state !== "ready") {
          show({
            state
          });
          if (state === "no-repo")
            await remind("setup", force, () => context.ui.toast.show({
              title: "Config not synced",
              message: "Your opencode config folder is not a git repository. Run /config-sync-setup to sync it.",
              variant: "info",
              duration: 1e4
            }));
          return;
        }
        const status = await readStatus(repo, staleMs, fetchMs);
        show({
          state,
          status
        });
        if (status.outdated)
          await remind("outdated", force, () => context.ui.toast.show({
            title: "\u26A0\uFE0F OPENCODE CONFIG REPO OUT OF SYNC",
            message: `${status.reasons.join(" \xB7 ")}. Run /config-sync when ready. (click to dismiss)`,
            variant: "warning",
            duration: STICKY_MS
          }));
      } catch {
        show(undefined);
      } finally {
        running = false;
        settle();
        if (pending) {
          pending = false;
          refresh();
        }
      }
    };
    const failed = (title, error) => context.ui.toast.show({
      title,
      message: `${printable(error.message, true)} (click to dismiss)`,
      variant: "error",
      duration: STICKY_MS
    });
    const confirmSecrets = async (found) => await context.ui.dialog.select({
      title: "\u26A0\uFE0F Possible secrets in the staged files",
      options: [{
        title: "Cancel",
        value: "cancel",
        description: "Review the files first; add them to .gitignore or use {env:\u2026}"
      }, {
        title: "Ignore and continue",
        value: "ignore",
        description: "Commit and push them anyway"
      }, ...found.map((entry) => ({
        title: `  ${printable(entry)}`,
        value: "cancel",
        disabled: true
      }))]
    }) === "ignore";
    const commitMessage = (description, value) => new Promise((resolve) => {
      let settled = false;
      const settle = (message) => {
        if (settled)
          return false;
        settled = true;
        resolve(message);
        return true;
      };
      const done = (message) => {
        if (settle(message))
          context.ui.dialog.clear();
      };
      context.ui.dialog.show(() => _$createComponent2(CommitDialog, {
        title: "Commit config changes",
        description,
        value,
        onCommit: done,
        onCancel: () => done(undefined)
      }), () => settle(undefined));
    });
    const exclusive = async (task) => {
      if (busy)
        return context.ui.toast.show({
          message: "Config sync is already running",
          variant: "info"
        });
      busy = true;
      pending = false;
      try {
        await idle;
        await task();
      } finally {
        busy = false;
        refresh();
      }
    };
    const runSync = () => exclusive(async () => {
      try {
        if (await repoState(repo) === "no-repo")
          return void await runSetup();
        const status = await readStatus(repo, staleMs, fetchMs);
        if (status.unpushedSubmodules.length)
          return failed("Config sync stopped", new Error(unpushedMessage(status.unpushedSubmodules)));
        if (status.dirtySubmodules.length) {
          const proceed = await context.ui.dialog.select({
            title: "Submodules have uncommitted work",
            options: [{
              title: "Ignore and sync the rest",
              value: "ignore",
              description: `Leaves the work in ${printable(status.dirtySubmodules.join(", "))} uncommitted`
            }, {
              title: "Cancel",
              value: "cancel",
              description: "Commit or discard the submodule work first"
            }]
          });
          if (proceed !== "ignore")
            return context.ui.toast.show({
              message: "Config sync cancelled",
              variant: "info"
            });
        }
        let message;
        if (status.files.length) {
          await stageAll(repo);
          const found = await stagedSecrets(repo);
          if (found.length && !await confirmSecrets(found))
            return context.ui.toast.show({
              message: "Config sync cancelled; the changes stay staged",
              variant: "info"
            });
          const staged = await readStatus(repo, staleMs, fetchMs);
          message = (await commitMessage(`${plural(staged.files.length, "staged file")} will be committed.`, proposeMessage(staged.files)))?.trim();
          if (!message)
            return context.ui.toast.show({
              message: "Config sync cancelled; the changes stay staged",
              variant: "info"
            });
        }
        const result = await sync(repo, message, (step) => context.ui.toast.show({
          message: `Config sync: ${step}\u2026`,
          variant: "info",
          duration: 2000
        }));
        context.ui.toast.show({
          title: "Config sync",
          message: `Config repo synced \u2713 (\u2191${result.pushed} pushed, \u2193${result.pulled} pulled)`,
          variant: "success"
        });
      } catch (error) {
        failed("Config sync failed", error);
      }
    });
    const runFetch = () => exclusive(async () => {
      try {
        const state = await repoState(repo);
        if (state !== "ready") {
          context.ui.toast.show({
            title: "Config sync",
            message: "Config repo is not set up; run /config-sync-setup",
            variant: "info"
          });
          return;
        }
        const {
          before,
          after
        } = await fetchRepo(repo);
        const fetched = after - before;
        context.ui.toast.show({
          title: "Config fetch",
          message: fetched > 0 ? `Fetched \u2193${fetched} new commit${fetched === 1 ? "" : "s"} to pull` : "Already up to date",
          variant: "success"
        });
      } catch (error) {
        failed("Config fetch failed", error);
      }
    });
    const runSetup = async () => {
      try {
        if (await repoState(repo) !== "no-repo")
          return context.ui.toast.show({
            message: "Config folder is already a git repository",
            variant: "info"
          });
        const mode = await context.ui.dialog.select({
          title: "Set up config sync",
          options: [{
            title: "Pull existing config",
            value: "existing",
            description: "This machine joins a repo you already push to"
          }, {
            title: "Start new",
            value: "new",
            description: "Push this machine's config to a new, empty repo"
          }]
        });
        if (!mode)
          return;
        const url = (await context.ui.dialog.prompt({
          title: "Git remote URL",
          description: "Uses your normal git credentials (SSH key or credential helper).",
          placeholder: "git@example.com:you/opencode-config.git"
        }))?.trim();
        if (!url)
          return;
        if (mode === "new") {
          if (!await setupNew(repo, url, "initial import", confirmSecrets))
            return context.ui.toast.show({
              message: "Config sync setup cancelled; nothing was changed",
              variant: "info"
            });
          context.ui.toast.show({
            title: "Config sync",
            message: "Config pushed to the new repo \u2713",
            variant: "success"
          });
          return;
        }
        const result = await setupExisting(repo, url);
        context.ui.toast.show({
          title: "Config sync",
          message: result.backup ? `Remote config checked out. ${plural(result.moved.length, "local file")} moved to ${result.backup}/ (click to dismiss)` : "Remote config checked out \u2713",
          variant: "success",
          duration: result.backup ? STICKY_MS : undefined
        });
      } catch (error) {
        failed("Config sync setup failed", error);
      }
    };
    context.ui.slot({
      append: "prompt.footer.status",
      render: () => _$createComponent2(FooterStatus, {})
    });
    context.ui.slot({
      append: "sidebar.content",
      render: () => _$createComponent2(SidebarStatus, {})
    });
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "config-sync.sync",
        title: "Sync config repo (commit, pull --rebase, push)",
        group: "Config sync",
        palette: true,
        slash: {
          name: "config-sync"
        },
        run: () => runSync()
      }, {
        id: "config-sync.refresh",
        title: "Refresh config repo sync status",
        group: "Config sync",
        palette: true,
        slash: {
          name: "config-sync-refresh"
        },
        run: () => refresh(true)
      }, {
        id: "config-sync.fetch",
        title: "Fetch config repo",
        group: "Config sync",
        palette: true,
        slash: {
          name: "config-sync-fetch"
        },
        run: () => runFetch()
      }, {
        id: "config-sync.setup",
        title: "Set up config repo sync",
        group: "Config sync",
        palette: true,
        slash: {
          name: "config-sync-setup"
        },
        run: () => exclusive(runSetup)
      }]
    }));
    let debounce;
    const onChange = (_event, file) => {
      const path = String(file ?? "").replaceAll("\\", "/");
      if (IGNORED.some((pattern) => pattern.test(path)))
        return;
      clearTimeout(debounce);
      debounce = setTimeout(() => void refresh(), WATCH_DEBOUNCE_MS);
    };
    let watcher;
    try {
      watcher = watch(repo, {
        recursive: true
      }, onChange);
    } catch {}
    const stopEvents = context.data.on("session.execution.succeeded", () => void refresh());
    const timer = setInterval(() => void refresh(), refreshMs);
    refresh();
    return () => {
      disposed = true;
      setView(undefined);
      stopEvents();
      clearInterval(timer);
      clearTimeout(debounce);
      watcher?.close();
    };
  }
});
export {
  tui_default as default
};
