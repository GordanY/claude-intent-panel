# intent-tracker

A Claude Code mod that keeps a side pane, **🎯 本次目標**, showing in plain words what the current work is for and which goals are met, so a long, technical session never loses sight of its original intent.

- **Purpose and goals**: Claude records a one-line purpose and 1–5 goals, each with a plain-language summary and the concrete check that proves it.
- **Your own words**: every goal (and the purpose) has an input field for your own wording; it reaches Claude beside your next prompt and is treated as authoritative.
- **Auto-tick with evidence**: Claude ticks a goal only after its check actually ran and passed, and records the evidence. A tick without evidence is refused.
- **Drift warning**: after each turn a small model (Haiku) checks the turn against the list and flags off-list work, with *add to list* / *ignore* buttons.
- **Per worktree**: the list is saved per project root, so quitting the CLI and resuming shows the same pane. When a worktree's folder is removed (its parent folder still present), its list is deleted at the next CLI start. A **清空清單** button (two presses) resets it.

The pane's labels and Claude's summaries are in Traditional Chinese.

## Install

At the prompt of a terminal session:

```
/plugin install intent-tracker --marketplace GordanY/claude-intent-panel
```

Answer `y` to add the marketplace, then choose the **user** scope so every session in every repository has the pane.

From a shell:

```
claude plugin install intent-tracker --marketplace GordanY/claude-intent-panel
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `GordanY/claude-intent-panel`, then **Add plugin**.

This repository is private: installing needs read access on GitHub and a git credential for github.com already on the machine (an SSH key, or `gh auth login` then `gh auth setup-git`).

## Use

- The pane opens by itself when the terminal is wide enough (about 144 columns); type `/intents` to open it at any width.
- Close it with its close mark: once you close it, list changes no longer reopen it in that session. `/intents` brings it back.
- **重新整理 AI 內容** asks Claude to redo the AI side (purpose, goal summaries, checks and ticks) from the current conversation; your own words are never changed.
- In the terminal, move focus into the pane with `ctrl+x tab` (or click) to type in a field.

## Develop

```
claude plugin validate .
claude plugin test .
```
