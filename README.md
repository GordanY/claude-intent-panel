# intent-tracker

A Claude Code mod that keeps a side pane, **Goals**, showing in plain words what the current work is for and which goals are met, so a long, technical session never loses sight of its original intent.

- **Only what you asked for, in two layers**: a **request** is something you asked for, quoting your own words (the mod checks the quote against the conversation and refuses words you never said, so Claude's own ideas and technical steps stay off the list; a suggestion of Claude's joins only once you say yes). Claude breaks each request into **parts** you would recognise as pieces of it, in plain outcome words, so a one-line request still shows real progress. Progress counts parts; a request is done when all its parts are.
- **Order and focus**: parts are kept in the order they will be done (labelled 1a, 1b, … under request 1): ✓ done, ● being worked on, ○ later. Several parts can be ● at once, each with its own *now: testing* / *now: investigating*: the session's own work shows on the parts Claude marked, and a subagent sent for a part shows on that part. Claude shapes parts by the kind of work (a bug: "it no longer happens" + "nothing else broke"; a refactor: "it behaves the same"; a question: "you have your answer"), and adds, edits, reorders or cancels them without asking; you get one notice per turn naming what changed.
- **Re-planning**: when the work shows a part no longer applies (the root cause or approach changed), it is marked *may be out of date* and Claude re-plans it. A changed request carries the parts that still apply over to the new one.
- **Limits**: things you said must not happen ("don't touch sync") sit in their own section as *holding* or *broken*, never ticked and never counted as progress.
- **Changes of mind**: drop a request (✕ in the pane, or say so) and it is cancelled with your words as the reason, its parts with it; change what you want and the new request replaces the old one. Either can be restored by asking Claude.
- **Latest only**: the pane shows the current state and nothing else: no history, no cancelled or replaced items, no before/after of an edit. ⋯ beside an item shows the words that asked for it and its evidence (finished items are listed without their evidence). (The record is kept for Claude, so a cancel can still be undone.)
- **Your words, wherever you typed them**: a prompt, a message typed while Claude is working (read back from the transcript, so it still counts after a reload or resume), or your pick in a question dialog all count as your own words for a request's source.
- **Now**: what is happening (plan, investigate, build, test, fix, review) is worked out from the actual tool calls, no model involved (edits after a failed test read as fixing), shown beside each ● part, or under the progress bar when no part is marked; when a turn ends it clears, except where a subagent is still working.
- **Your own words**: press ✎ beside the purpose or a goal to write it your way; it reaches Claude beside your next prompt and is treated as authoritative, and it leads where both are shown.
- **Auto-tick with evidence**: Claude ticks a goal only after its check actually ran and passed, and records the evidence. A tick without evidence is refused.
- **Drift warning**: after each turn a model of your choice (Haiku by default) checks the turn against the list and flags off-list work, with *add to list* / *ignore* buttons.
- **Live progress, no upkeep**: when a test or build finishes, a subagent reports back, or a background task's notification arrives, the open goals ride along with the result (hidden from you), so Claude ticks or reopens a goal the moment its check runs, not when someone remembers.
- **Observer**: a small model (Haiku by default) reads each result as it arrives and each finished turn. It only ever adds: it ticks a goal or part the output shows passing (counted at once, tagged *seen in output*), marks a limit broken, and flags a part *may be out of date*; at the end of a turn it also records a request, a drop or a change of mind Claude missed, from your exact words only (tagged *needs confirming* until Claude confirms). It never unticks or edits the plan.
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
- Below a divider at the very bottom, one light line of metadata: when the list last changed; **goals** and the model writing and ticking them (the session's own model, so it follows the session); **drift** and the model doing the drift check, which you can change: press its name and pick Haiku, Sonnet or Opus (saved on your machine for every worktree and session, like the language; Haiku is the cheapest); and 🌐 the language.
- In the terminal, move focus into the pane with `ctrl+x tab` (or click) to type in a field.

## Develop

```
claude plugin validate .
claude plugin test .
```
