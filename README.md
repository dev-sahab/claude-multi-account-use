# ccm: multi-account switcher for Claude Code

Use **several Claude subscriptions** with the **official** Claude Code, both the **terminal CLI** and the **VS Code extension**, without logging in again and again.

- Log in to each account **once**. No more re-verifying every time you switch.
- **Switch manually** with one command: `ccm use work`.
- **Auto-switch** to the next account when one hits its usage limit.
- Your **conversation history, commands, agents and skills are shared** between accounts, so context is kept when you switch.
- You keep the official UI. This tool does not replace Claude Code, it only decides *which account* it runs with.

> **Unofficial community tool.** Not affiliated with or endorsed by Anthropic. See [Terms and responsibility](#terms-and-responsibility).

| Platform | Status |
|---|---|
| macOS | Used and tested with the VS Code extension and the CLI |
| Linux | Logic tested; same code path as macOS |
| Windows | **Not tested yet.** Should work (it uses folder junctions, no admin needed). The VS Code extension part is the least certain, see [Troubleshooting](#troubleshooting) |

---

## Table of contents

1. [How it works (short)](#how-it-works-short)
2. [Before you start](#before-you-start)
3. [Install](#install)
4. [Add your accounts](#add-your-accounts)
5. [Connect the VS Code extension](#connect-the-vs-code-extension)
6. [Daily use](#daily-use)
7. [What happens when you hit a limit](#what-happens-when-you-hit-a-limit)
8. [Check that it really works](#check-that-it-really-works)
9. [Command reference](#command-reference)
10. [Configuration](#configuration)
11. [Troubleshooting](#troubleshooting)
12. [Uninstall](#uninstall)
13. [Limitations](#limitations)
14. [Terms and responsibility](#terms-and-responsibility)
15. [License](#license)

---

## How it works (short)

Claude Code stores its login and settings in a folder (by default `~/.claude`). It can be pointed to a different folder with the `CLAUDE_CONFIG_DIR` environment variable. `ccm` does this:

```
~/.claude              <- account "main"  (your existing login; ALL sessions, skills, settings live here)
~/.claude-work         <- account "work"  (only its own login)
        projects/  ----+
        skills/    ----+--> links to ~/.claude/...   (so everything is stored once, in "main")
        settings.json -+
        ...
```

- Each account keeps **its own login**. Everything else that matters (sessions, skills, commands, agents, plugins, settings) is **stored once, in the first account you add**, and the other accounts only hold links to it. So a conversation started on one account can be resumed on another, and a session is never "lost" in a secondary account's folder.
- For the **terminal**, `ccm` starts `claude` with the chosen account. If a limit is hit, it restarts `claude --continue` with the next free account.
- For the **VS Code extension**, `ccm` sits between VS Code and `claude` using the extension's official `claudeCode.claudeProcessWrapper` setting. Every time the extension starts a Claude process, `ccm` picks the account and watches the output for a "limit reached" message.
- `ccm` makes **no network requests** and never reads or copies your login tokens. It only sets an environment variable, manages the links, and reads the last few lines of the newest conversation file to detect a limit message.

### What is shared and what is not

| Shared (stored once in the first account) | Not shared (stays per account) |
|---|---|
| `projects/` (all conversations + per-project memory) | `.credentials.json`, `.claude.json` (login, account identity, local MCP server list) |
| `skills/`, `commands/`, `agents/`, `output-styles/` | **claude.ai connectors** (Slack, Gmail, ...). These belong to the claude.ai account, not to this computer. Connect them on each account, or add the same MCP server locally on each account |
| `plugins/`, `settings.json`, `CLAUDE.md` | usage and limits (they are per account, by nature) |
| `todos/`, `plans/`, `file-history/`, `session-env/`, `ide/`, `history.jsonl` | caches, telemetry |

You can share more folders by adding their names to `shareExtra` in `config.json` (see [Configuration](#configuration)).

---

## Before you start

You need:

1. **Node.js 16 or newer** (the script has no other dependencies).
2. **Claude Code** installed and working. For the terminal commands, `claude` must run in your terminal.
3. (Optional) **VS Code** with the official **Claude Code** extension.
4. Two or more Claude accounts (the first one should already be logged in on this computer).

Check Node.js:

```bash
node --version
```

If you see `v16` or higher, you are fine. If not, install the LTS version from <https://nodejs.org>.

Check Claude Code:

```bash
claude --version
```

If this says "command not found", install Claude Code first by following the official docs: <https://code.claude.com/docs>.

---

## Install

### Step 1: Get the files

Pick one:

**A) Download ZIP**: on the GitHub page click **Code → Download ZIP**, then unzip it (for example into your `Downloads` folder).

**B) Git**:

```bash
git clone https://github.com/dev-sahab/claude-multi-account-use.git
cd claude-multi-account-use
```

### Step 2: Open a terminal in that folder

If you used **git clone**, you are already inside the folder (`claude-multi-account-use`). If you downloaded the **ZIP**, GitHub names the unzipped folder `claude-multi-account-use-main`:

- **macOS / Linux**: `cd ~/Downloads/claude-multi-account-use-main`
- **Windows (PowerShell)**: `cd $HOME\Downloads\claude-multi-account-use-main`

(Adjust the path if you unzipped somewhere else.)

### Step 3: Run setup

```bash
node ccm.js setup
```

This copies the script to a permanent place and creates two small launchers:

| OS | Location |
|---|---|
| macOS / Linux | `~/.claude-multi/` |
| Windows | `C:\Users\<you>\.claude-multi\` |

At the end it prints **two things you need**: a folder to add to your PATH, and a VS Code setting line. Keep that output visible (you can run `node ccm.js setup` again any time to print it again).

### Step 4: Add the launcher folder to your PATH

This lets you type `ccm` from anywhere.

#### macOS (default shell zsh)

Run this **exactly as one line** (do not type `~/.zshrc` as a command):

```bash
echo 'export PATH="$HOME/.claude-multi/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

#### Linux (bash)

```bash
echo 'export PATH="$HOME/.claude-multi/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

(If you use zsh on Linux, replace `.bashrc` with `.zshrc`.)

#### Windows (PowerShell)

```powershell
$old = [Environment]::GetEnvironmentVariable("Path", "User")
[Environment]::SetEnvironmentVariable("Path", "$old;$env:USERPROFILE\.claude-multi\bin", "User")
```

Then **close the terminal and open a new one**.

*No-PowerShell alternative:* Start menu → search **"Edit environment variables for your account"** → select `Path` → **Edit** → **New** → paste `C:\Users\<you>\.claude-multi\bin` → OK.

### Step 5: Check it works

Open a **new** terminal and run:

```bash
ccm status
```

You should see:

```
auto-switch: on
```

(with no accounts listed yet). If you get "command not found" or "not recognized", see [Troubleshooting](#troubleshooting).

---

## Add your accounts

### Step 1: Register your first account

The **first** account you add should be the one that is **already logged in** to Claude Code on this computer. It keeps using the default `~/.claude` folder, so your login and existing history stay as they are:

```bash
ccm add main
```

> If you are not logged in to any account yet, run `claude`, type `/login`, finish, type `/exit`, and then run `ccm add main`.

You can use any names you like (`main`, `work`, `personal`, ...).

### Step 2: Register the other accounts

```bash
ccm add work
ccm add personal
```

You will see lines like `linked projects -> ...`. That is the shared history being connected.

### Step 3: Log in to each extra account (one time only)

```bash
ccm signin work
```

Claude opens. Then:

1. Type `/login` and press Enter.
2. In the browser, **log in with the email of that account**.
3. When it says you are logged in, type `/exit`.

Repeat for the next account:

```bash
ccm signin personal
```

> **Watch out:** if your browser is already logged in to Claude with another account, Claude may log in with that one. Log out in the browser first (or use a private window), so each slot really gets a different account.

### Step 4: Check

```bash
ccm status
```

```
auto-switch: on
* main         ok          /Users/you/.claude
  work         ok          /Users/you/.claude-work
  personal     ok          /Users/you/.claude-personal
```

The `*` marks the account used for new sessions.

### Step 5: Make sure everything is stored in the first account

```bash
ccm doctor
```

You want to see `All good: every account stores sessions and skills in the first account.`

If it lists items that need attention (for example an account folder that already had its own `projects/` from before you used `ccm`), close the VS Code Claude panels and any running Claude terminals, then:

```bash
ccm link
```

This **moves** what the other accounts saved into the first account and links it. Nothing is deleted: if two files have the same name but different content, both are kept (the second as `name.from-<account>`). `ccm link --dry-run` shows what would happen without changing anything.

---

## Connect the VS Code extension

Skip this section if you only use the terminal.

### Step 1: Open your user settings as JSON

In VS Code press **Cmd+Shift+P** (macOS) or **Ctrl+Shift+P** (Windows/Linux), type:

```
Preferences: Open User Settings (JSON)
```

and press Enter.

### Step 2: Add the wrapper setting

Add the line that `ccm setup` printed. It looks like this (use **your** printed path):

macOS / Linux:

```json
"claudeCode.claudeProcessWrapper": "/Users/you/.claude-multi/bin/ccm-wrap"
```

Windows:

```json
"claudeCode.claudeProcessWrapper": "C:\\Users\\you\\.claude-multi\\bin\\ccm-wrap.cmd"
```

Inside the file, keep valid JSON: it goes **inside the outer `{ }`**, and the line before it needs a **comma**:

```json
{
  "editor.fontSize": 14,
  "claudeCode.claudeProcessWrapper": "/Users/you/.claude-multi/bin/ccm-wrap"
}
```

Settings file locations (if you prefer to edit the file directly):

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Code/User/settings.json` |
| Linux | `~/.config/Code/User/settings.json` |
| Windows | `%APPDATA%\Code\User\settings.json` |

### Step 3: Reload VS Code

**Cmd/Ctrl+Shift+P → `Developer: Reload Window`**

### Step 4: Confirm the wrapper runs

Send any message in the Claude panel, then look at the log:

```bash
# macOS / Linux
tail -n 5 ~/.claude-multi/ccm.log
```

```powershell
# Windows
Get-Content $HOME\.claude-multi\ccm.log -Tail 5
```

You should see lines like:

```
2026-.. wrap start account=main cmd=.../claude
```

If you do, the extension is going through `ccm`. 🎉

> VS Code forks (Cursor, Windsurf, etc.) were not tested.

---

## Daily use

### Terminal

Use `ccm` **instead of** `claude`. Everything after `ccm` is passed to `claude`:

```bash
cd my-project
ccm                       # same as: claude
ccm --model sonnet        # same as: claude --model sonnet
ccm run --resume          # "run" is optional, handy if an argument clashes with a ccm command
```

### VS Code

Use the Claude extension as normal. `ccm` chooses the account every time the extension starts a Claude process (new chat, resumed chat, reload).

### Switch manually

```bash
ccm use work
```

The change applies to **new** Claude sessions. A conversation that is already running keeps its account until you start or resume a conversation (or reload VS Code).

### Turn auto-switch on or off

```bash
ccm auto off
ccm auto on
```

---

## What happens when you hit a limit

### In the terminal

1. The limit message appears in Claude.
2. Type `/exit`.
3. `ccm` notices the limit, marks that account as limited until its reset time, and **automatically restarts `claude --continue` on the next free account**. You get 3 seconds to press **Ctrl+C** to cancel.
4. If every account is limited, it stops and tells you. `ccm status` shows when each resets.

### In VS Code

`ccm` marks the account as limited when it sees the limit message in the output. The **conversation that is already open stays on that account** (the extension owns that process and it cannot be moved mid-conversation), so clicking "continue" in the same chat will keep showing the limit. To continue on another account, **start a new chat, resume the conversation, or reload the window**; `ccm` picks the next free account, and your history is there because it is shared.

**Experimental: `ccm restart on`.** With this on, `ccm` stops the Claude process about 1.5 seconds after it detects a limit (only if another account is free). The idea is that the extension then starts a new process on its next message, which goes through `ccm` and lands on the free account. Whether the extension restarts and resumes cleanly after the process stops has not been verified for every version, so it is **off by default**. Try it, and use `ccm restart off` if it behaves badly. Your conversation is saved on disk either way.

### Reset times

If the message contains a reset time such as `resets 5pm`, `ccm` uses it. Otherwise it assumes a 5-hour cooldown (`cooldownMinutes` in the config). Weekly limits with a date are not parsed, so they use the 5-hour fallback. Use `ccm limit` / `ccm clear` to correct things by hand.

---

## Check that it really works

**Do not** ask Claude "who am I?". Claude answers from your git config and project files (for example, a `CLAUDE.md` that mentions your name), not from the account in use, so the answer will look the same for every account.

Use these instead:

1. **The log**: `ccm log` shows the last `wrap start account=...` lines, i.e. which account was chosen.
2. **Account & Usage** in the Claude panel (or `/status` in the terminal): the **email** and the **usage percentages** differ per account.
3. **`ccm status`**: shows the selected account and any limits.

Test:

```bash
ccm use work
# VS Code: Developer: Reload Window, send a message
tail -n 3 ~/.claude-multi/ccm.log     # should say account=work
ccm use main
```

---

## Command reference

| Command | What it does |
|---|---|
| `ccm add <name> [dir]` | Register an account. First one defaults to `~/.claude`; others get `~/.claude-<name>` |
| `ccm signin <name>` | Open Claude for that account so you can `/login` once |
| `ccm use <name>` | Select the account for new sessions (also clears its limit mark) |
| `ccm status` | List accounts, the current one (`*`) and limit reset times |
| `ccm auto on` / `ccm auto off` | Enable or disable auto-switch on limit |
| `ccm limit [name]` | Manually mark an account as limited (current one by default) |
| `ccm clear [name]` | Clear limit marks (`all` by default) |
| `ccm remove <name>` | Unregister an account (its folder stays) |
| `ccm remove <name> --purge` | Unregister and delete its folder and login |
| `ccm check "<text>"` | Test whether a text would be treated as a limit message |
| `ccm doctor` | Check that sessions, skills and settings are stored once, in the first account |
| `ccm link [--dry-run]` | Fix what `doctor` reports: move what other accounts saved into the first account and link it (asks before doing it; `--yes` skips the question) |
| `ccm log [n]` | Show the last `n` lines (default 30) of the log |
| `ccm restart on` / `ccm restart off` | **Experimental.** VS Code: stop the Claude process right after a limit so the extension can restart it on the next account (see below) |
| `ccm setup` | (Re)install launchers and print PATH + VS Code instructions |
| `ccm version` | Print the version |
| `ccm [run] [claude args]` | Run `claude` with auto-switch and auto-resume |
| `ccm wrap <claude> [args]` | Used internally by the VS Code extension |

**Replace an account** (for example `work` should use a different email):

```bash
ccm signin work     # then: /logout, /login with the new email, /exit
```

or start fresh: `ccm remove work --purge`, then `ccm add work` and `ccm signin work`.

The **first** account cannot be removed while others exist (it holds the shared history). Remove the others first.

---

## Configuration

Files live in `~/.claude-multi/` (Windows: `C:\Users\<you>\.claude-multi\`):

| File | Purpose |
|---|---|
| `config.json` | Accounts, `auto`, `cooldownMinutes`, `patterns` |
| `state.json` | Current account and limit marks |
| `ccm.log` | What the wrapper did (account choices, limit detections) |

`config.json` options (all optional):

```json
{
  "auto": true,
  "restartOnLimit": false,
  "cooldownMinutes": 300,
  "patterns": ["my extra regex"],
  "shareExtra": ["some-folder-name"]
}
```

- `shareExtra`: extra file/folder names inside the Claude config folder to store once in the first account (run `ccm link` after adding one). `ccm doctor` lists entries in other accounts that are not shared, which helps you find out where something got saved.
- `patterns` are extra case-insensitive regular expressions. They are **added to the built-in ones** (the built-ins cover phrases like "hit your limit", "reached your usage limit", "limit reached/exceeded"). They are tested against the **text of short result/assistant messages** only (not tool output, control messages or long answers), to avoid false alarms.
- If Claude's real limit message does not match, look at `ccm log`: near-misses are logged as `NEAR-MISS (not matched) ...` with the exact text. Test a message with `ccm check "the message"`, then add a pattern.

---

## Troubleshooting

| Problem | What to do |
|---|---|
| `ccm: command not found` / `'ccm' is not recognized` | The PATH step was not applied. Open a **new** terminal. macOS/Linux: `echo $PATH` should contain `.claude-multi/bin`. Windows: re-check the environment variable. |
| `zsh: permission denied: ~/.zshrc` | You typed the file name as a command. Use the `echo '...' >> ~/.zshrc` line from the install step. |
| `claude: command not found` when running `ccm signin` / `ccm` | The Claude Code CLI is not installed or not on PATH. Install it from the official docs and open a new terminal. |
| `ccm.log` does not exist | The wrapper never ran. Check the setting name (`claudeCode.claudeProcessWrapper`), valid JSON, then **Reload Window** and send a message. |
| Log shows the wrong account | `ccm use <name>`, then reload VS Code or start a new chat. Running conversations keep their account. |
| Claude says I am a different person | See [Check that it really works](#check-that-it-really-works). Claude is reading your project, not your account. |
| An account is marked `LIMITED` but is not | `ccm clear`. If it keeps happening, open the log, find the `LIMIT` line and open an issue with it. |
| Limit hit but nothing was detected / "continue" keeps showing the limit | Run `ccm log 40` and look for `LIMIT` (detected) or `NEAR-MISS` / `RATE-EVENT` (seen but not matched; the exact text is logged). If there is no `LIMIT` line, add a pattern and open an issue with the logged text. If there **is** a `LIMIT` line, the account was marked correctly but the open chat is still bound to it: start a new chat or reload the window, or try `ccm restart on`. |
| Sessions, notes or skills show up in a secondary account's folder | Run `ccm doctor`, then `ccm link`. If `doctor` lists a folder name under "other entries that are NOT shared", put that name in `shareExtra` in `config.json` and run `ccm link` again. |
| `has its own content` during `ccm add` / `ccm status` warns that items are not linked | That account's folder already has its own `projects/` etc. Close VS Code Claude panels and Claude terminals, then run `ccm link` (it merges the content into the first account and links it). |
| macOS asks for login again on the first account | Make sure the **first** account was added with `ccm add <name>` and no custom folder, so it uses the default `~/.claude`. |
| **Windows:** extension stops working after adding the wrapper | Remove the `claudeCode.claudeProcessWrapper` line, reload, and open an issue with `ccm.log` and the error. The `.cmd` launcher may need an adjustment. |
| **Windows:** link/junction errors | Run `ccm add` again from a normal PowerShell and open an issue with the exact error message. |

---

## Uninstall

1. Remove the `claudeCode.claudeProcessWrapper` line from VS Code settings, reload the window.
2. Remove the extra accounts (this also removes their logins):
   ```bash
   ccm remove work --purge
   ccm remove personal --purge
   ```
3. Delete the tool folder:
   - macOS / Linux: `rm -rf ~/.claude-multi`
   - Windows (PowerShell): `Remove-Item -Recurse -Force $HOME\.claude-multi`
4. Remove the PATH line you added (`~/.zshrc` / `~/.bashrc`, or the Windows environment variable).

Your first account and its history in `~/.claude` are never deleted by these steps.

---

## Limitations

- **A running VS Code conversation cannot be moved to another account mid-way.** The switch happens on the next session start (new chat, resume, reload).
- Limit detection relies on **message text**. If Claude Code changes its wording, add a pattern (the log shows the near-miss text).
- Weekly limits that show a date (not a time) fall back to the 5-hour cooldown.
- In terminal auto-resume, only `--continue` is passed on the new account; other flags from the first start (model, permissions) are not repeated.
- A new account has no **prompt cache**, so the first message after a switch re-processes the whole context and can use more of that account's quota.
- **claude.ai connectors are not shared** (they belong to the claude.ai account). Locally added MCP servers live in `.claude.json`, which is never shared because it also identifies the account.
- On Windows, file links (`settings.json`, `CLAUDE.md`) need Developer Mode or admin rights; folder links do not. If a file link fails, `ccm link` says so and the folders are still shared.
- Windows and VS Code forks are untested.

---

## Terms and responsibility

This is an independent tool. It does not modify Claude Code or intercept your credentials. Whether using multiple accounts, and in particular switching accounts when a usage limit is reached, is allowed is governed by Anthropic's terms and usage policies. **Read them and use only accounts you are entitled to use.** You are responsible for how you use this tool.

---

## License

MIT, see [LICENSE](LICENSE).
