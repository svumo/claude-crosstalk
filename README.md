<p align="center">
  <img src="assets/banner.svg" alt="Crosstalk: let your Claude Code sessions talk to each other, across multiple Claude accounts and other AI providers." width="100%">
</p>

<p align="center">
  <a href="#install"><img src="https://img.shields.io/badge/install-one_line-8b5cf6?style=for-the-badge&labelColor=1b1b3a" alt="Install in one line"></a>
  <a href="#what-it-works-with"><img src="https://img.shields.io/badge/works_with-any_provider-2dd4bf?style=for-the-badge&labelColor=1b1b3a" alt="Works with any provider Claude Code can use"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-7dd3fc?style=for-the-badge&labelColor=1b1b3a" alt="MIT licence"></a>
</p>

<p align="center">
  <b>Tell one session what you want. It hands the work to your other sessions, and they reply when they're done.</b><br>
  Idle sessions wake up by themselves, on any account and any provider.
</p>

<p align="center">
  <img src="assets/example.svg" alt="You ask Claude Code, acting as orchestrator, to review, test and document your work. It sends jobs through Crosstalk to sessions on three Claude accounts and on other AI providers: GPT and Gemini through a gateway, GLM, DeepSeek and more. Each wakes up by itself and replies through Crosstalk, and the orchestrator reports back to you." width="100%">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#use-it">Use it</a> ·
  <a href="#multiple-claude-accounts">Multiple accounts</a> ·
  <a href="#what-it-works-with">Providers</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#costs-and-safety">Costs and safety</a>
</p>

## Install

At the prompt of a terminal session:

```text
/plugin install crosstalk --marketplace svumo/claude-crosstalk
```

Then restart any session that was already open. That's it for a single profile.

<details>
<summary><b>From a shell, or the desktop app</b></summary>

From a shell:

```bash
claude plugin install crosstalk --marketplace svumo/claude-crosstalk
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `svumo/claude-crosstalk`, then **Add plugin**.

</details>

## Use it

Just ask, in plain words:

- "List the other sessions."
- "Ask the session on my second account to review my changes."
- "Send work a message saying the build is fixed."

| Command | What it does |
|---|---|
| `/crosstalk` | Shows this session's address and who it can reach |
| `/crosstalk off` | Pauses it: messages wait |
| `/crosstalk on` | Turns it back on |

**Addresses** look like `profile/folder-xxxx`, such as `work/my-app-1a2b`. The profile name alone works when that profile has one session running.

Crosstalk carries the messages; it doesn't plan the work. Whichever session you ask does the orchestrating, so you can make any session the lead.

## Multiple Claude accounts

Claude Code's built-in messaging only reaches sessions on the same profile, because each profile keeps its own list of sessions. A session on one account can't see a session on another. Crosstalk connects them through a folder they can all read.

A *profile* is a separate Claude Code config folder, chosen with `CLAUDE_CONFIG_DIR`. Each one keeps its own login, so give each account its own:

```bash
# macOS or Linux
export CLAUDE_CONFIG_DIR=~/.claude-work
claude plugin install crosstalk --marketplace svumo/claude-crosstalk
claude
```

```powershell
# Windows PowerShell
$env:CLAUDE_CONFIG_DIR = "$HOME\.claude-work"
claude plugin install crosstalk --marketplace svumo/claude-crosstalk
claude
```

Repeat for each profile, then open a session on each. Run `/crosstalk` and they'll list each other.

**Names** come from the folder: `~/.claude` is `default`, `~/.claude-work` is `work`, and any other folder goes by its own name. To choose a name, set `CLAUDE_CROSSTALK_NAME`.

## What it works with

**Any AI provider you can point Claude Code at.** Claude Code speaks Anthropic's API format, so that means anything with an Anthropic-compatible endpoint, or any other model through a translating gateway such as LiteLLM. The model has to support tool calls, because that's how a session sends a message.

| Provider | How it connects | Status |
|---|---|---|
| Claude, on one or many accounts | Directly | Tested |
| GLM | Z.ai's Anthropic-compatible endpoint | Tested |
| DeepSeek and others with an Anthropic-compatible endpoint | Directly, using `ANTHROPIC_BASE_URL` | Should work, not tested |
| GPT, Gemini and others | Through a gateway such as LiteLLM | Should work, not tested |

Crosstalk runs on your computer, not in the model, so it doesn't care which model is on the other end. If you try a provider that isn't marked as tested, reports are welcome.

## How it works

<p align="center">
  <img src="assets/how-it-works.svg" alt="Sessions on any profile or provider share the folder ~/.claude-crosstalk. A message starts a turn if the session is idle, is read on its next step if it is running tools, and arrives when the turn ends if it is in one long step." width="100%">
</p>

Each session records that it's running and checks its own inbox. When a message arrives:

- **If the session is idle,** the message starts a turn.
- **If it's working,** the model reads the message on its next step, once the current tool calls finish.
- **If it's in one long step with no tools,** the message arrives when that turn ends.

To keep the folder somewhere else, set `CLAUDE_CROSSTALK_DIR` on every profile.

## Costs and safety

- **Wake-ups use tokens.** Each message that wakes a session uses that profile's tokens or usage. After 25 wake-ups in a row, new messages wait until you type, so two sessions can't keep replying to each other forever. Change this with the `wakeLimit` option.
- **Messages are plain text on disk,** so don't send passwords or keys.
- **Messages aren't your approval.** Any program on your computer can write to the folder, so each message is presented to the model as information from another session, and it's told to ask you before doing anything that needs your approval. That's an instruction to the model, not a hard block, so keep your normal permission settings on.

## Limits

- It only works between sessions on the same computer.
- Messages take a few seconds to arrive; it isn't instant.
- Records older than 7 days are cleared, which needs `node` on your PATH. Without it they just stay in the folder.
- Messages are capped at 20,000 characters. For anything bigger, write a file and send the path.

## Troubleshooting

| What you see | What to do |
|---|---|
| A session isn't listed | Restart it, as sessions only load the plugin when they start. Check it's installed on that profile. |
| "could be several sessions" | That profile has more than one session running, so use the whole address. |
| Two profiles show the same name | Set `CLAUDE_CROSSTALK_NAME` differently on each. |
| A message didn't wake a session | Run `/crosstalk` there. It may be off, or at its wake-up limit, which clears when you type. |
| A provider can't send messages | Its model may not support tool calls. |

## Tested on

Windows 11 with Claude Code 2.1.318. macOS and Linux should work but haven't been tested, so reports are welcome.

## Accounts and terms

Crosstalk shares no logins or usage limits: each profile keeps its own. If you use several accounts or providers, their terms still apply, so check them.

This is an independent project, not affiliated with or endorsed by Anthropic, OpenAI, Google, Z.ai, DeepSeek or any other AI provider. Their names and logos belong to them and are used only to show what Crosstalk can connect to.

## Development

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## Licence

[MIT](LICENSE)
