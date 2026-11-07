---
name: vm
description: Start a Linux machine (WSL Ubuntu on this PC) or a macOS machine (a GitHub Actions runner) and test Crosstalk's `open` there for real, run commands on it, or hold it open for SSH. Use when the user says "start the linux/mac vm", "test open on mac/linux", "run this on a mac", or "/vm".
---

# /vm: Linux and macOS machines for testing

Two machines, both driven from this PC. Neither needs a Claude Code login: `scripts/open-check.mjs`
checks `open` with a throwaway `claude-xtcheck` shortcut and prints PASS or FAIL.

| Target | What it is | Start-up |
|---|---|---|
| `linux` | WSL Ubuntu on this PC, with tmux and xterm (xterm windows show on the desktop through WSLg) | seconds |
| `mac` | A clean `macos-latest` GitHub Actions runner (Apple Silicon), free on this public repo | 2 to 4 minutes per run |

Run WSL commands with the PowerShell tool: Git Bash mangles `$` and loops passed through `wsl.exe`.
For anything longer than one line, write a script to the scratchpad and run it with `bash -l /mnt/c/...`.

## linux

```powershell
# Test open (tmux, then a real xterm window)
wsl -d Ubuntu --cd /mnt/c/Users/skdes/Documents/github/claude-crosstalk -- bash -lc "node scripts/open-check.mjs --terminal tmux"
wsl -d Ubuntu --cd /mnt/c/Users/skdes/Documents/github/claude-crosstalk -- bash -lc "node scripts/open-check.mjs --terminal xterm"

# Plugin tests, on Linux
wsl -d Ubuntu --cd /mnt/c/Users/skdes/Documents/github/claude-crosstalk -- bash -lc "claude plugin test ."

# Any command
wsl -d Ubuntu -- bash -lc "<command>"

# Stop it when done
wsl --terminate Ubuntu
```

- To try another terminal: `sudo apt-get install -y <terminal>` (sudo needs no password), then pass `--terminal <name>`.
- An xterm window that a check opens stays open, because the shell stays after Claude exits. Tell the person it's there.

## mac

The workflow is `.github/workflows/open-check.yml`. It installs Claude Code, runs `claude plugin test .`,
then `node scripts/open-check.mjs`. Inputs: `os` (`macos-latest`, `ubuntu-latest`, `both`), `run`
(a shell command run afterwards, whose output appears in the log), and `tmate` (hold for SSH).

The workflow runs code from a branch, so push first. `--ref` takes any branch, but the workflow file
has to be on `main` for `gh workflow run` to find it.

```bash
gh workflow run open-check.yml --ref <branch> -f os=macos-latest
sleep 5; id=$(gh run list --workflow open-check.yml -L 1 --json databaseId -q '.[0].databaseId')
gh run watch "$id" --exit-status > /dev/null     # run this in the background; it ends with the run
gh run view "$id" --log | grep -E "PASS|FAIL|pass|fail"   # once it's done
gh run view "$id" --log-failed                    # if it failed
```

- To run something on the Mac: `-f run='sw_vers; xcodebuild -version'`. Read the result in the "Your command" step of the log.
- **For SSH:** `-f tmate=true`. The address is posted as a notice once the session is up. Read it while the run is still going:
  `gh api repos/svumo/claude-crosstalk/check-runs/<job id>/annotations -q '.[].message'`, where `<job id>` comes from `gh run view "$id" --json jobs -q '.jobs[0].databaseId'`.
  Only the person who started the run can connect, with their GitHub SSH keys. The person connects with `ssh <address>`; tmate attaches to a terminal session, so it's for them, not for one-off commands from here. Use `run` for those. The session ends when they `touch /continue` or exit, if nobody connects within 10 minutes, or when the job times out after 90 minutes.
- A pull request that touches `hooks/`, `tests/` or this workflow runs it on both macOS and Linux by itself.

## Limits

- The Mac is a CI runner, not a desktop to look at. Results come back through the log.
- Nobody is there to answer macOS's "control Terminal?" prompt on a runner, so the workflow grants it
  ahead of time in the runner's own TCC database (runners have SIP off). If the Terminal check ever
  times out or fails with -1743, look at the "Let this runner control Terminal" step first: a new
  runner image may have moved the app that macOS asks on behalf of.
- A macOS VM on this PC isn't used. The CPU is AMD, and Intel macOS ends with macOS 26.
