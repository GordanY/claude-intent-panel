# intent-tracker

A Claude Code mod that keeps a side pane, **Goals**, showing in plain words what the current work is for and which goals are met, so a long, technical session never loses sight of its original intent.

- **Purpose and goals**: Claude records a one-line purpose and as many goals as the work really has, each with a plain-language summary and the concrete check that proves it.
- **Your own words**: press ✎ beside the purpose or a goal to write it your way; it reaches Claude beside your next prompt and is treated as authoritative, and it leads where both are shown.
- **Auto-tick with evidence**: Claude ticks a goal only after its check actually ran and passed, and records the evidence. A tick without evidence is refused.
- **Drift warning**: after each turn a small model (Haiku) checks the turn against the list and flags off-list work, with *add to list* / *ignore* buttons.
- **Per worktree, one source of truth**: the list is saved per project root in one store shared by every session on this machine, so quitting the CLI and resuming shows the same pane, and a terminal session and a desktop-app session in the same worktree show the same list: a change in either (a tick, your own words, a drift note, the language) appears in the other within about two seconds and reaches its model beside the next prompt. Every change reads the shared copy first, so neither overwrites the other. When a worktree's folder is removed (its parent folder still present), its list is deleted at the next CLI start. A **⌫ Clear list** button (two presses) resets it.

- **Language**: English by default. Pick 🌐 at the bottom of the pane: English, 中文, 日本語, or type your own. The choice is saved on your machine for every worktree and session. It sets the pane's labels (a custom language keeps English labels) and the language Claude writes the purpose, goals, checks, evidence and drift notes in. Text already written stays as it is until you press ↻.

## Where it runs

In the terminal and in the desktop app's Code tab alike: a user-scope install loads in both, and the pane draws on either surface. Only in sessions a person can see. A headless session (`claude -p`, the SDK, automation that runs Claude without a REPL) gets no pane, no instructions, no tools and no drift check. Subagents and teammates cannot change the main conversation's list. An interactive session another tool opens for you in a terminal is an ordinary session and does get the pane.

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

Update later with `/plugin marketplace update claude-intent-panel`, then `/reload-plugins` or a new session.

## Use

- The pane opens by itself when the terminal is wide enough (about 144 columns); type `/intents` to open it at any width.
- Close it with **✕ Close** at the bottom (or the pane's own close mark): once you close it, list changes no longer reopen it in that session. `/intents` brings it back.
- The buttons sit in a light toolbar at the bottom of the pane: icon and text when the pane is wide enough, icon alone when it is narrow (▶ start, ↻ refresh, ⌫ clear, ✕ close).
- An empty pane shows **▶ Start**: it asks Claude to build the purpose and goals from the conversation so far (useful in a session that was already running), ticking goals already verified.
- **↻ Refresh AI content** asks Claude to redo the AI side (purpose, goal summaries, checks and ticks) from the current conversation; your own words are never changed.
- The pane keeps the key information in view: the purpose in one line, a progress bar, any drift warning above the goals, then the open goals with their checks. Finished goals fold into one line (**✓ 3 done ▸**); open it for each goal and its evidence.
- Below a divider at the very bottom, one light line of metadata: when the list last changed, the model doing summaries and ticks (the session's own), the drift-check model (Haiku), and 🌐 the language.
- In the terminal, move focus into the pane with `ctrl+x tab` (or click) to type in a field.

## Develop

```
claude plugin validate .
claude plugin test .
```
