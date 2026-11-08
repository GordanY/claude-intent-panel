# intent-tracker

A Claude Code mod: a side pane, **Goals**, that shows in plain words what you asked for in this session and how far it has got.

## The pane at a glance

```
Fix disappearing drafts                      ✎
▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 1/3
> ◐ 1. Drafts never disappear 1/3          ✎ ✕ ⋯
    ● 1b. Drafts survive switching notebooks  now: testing
    ○ 1c. Sync still works
- ○ 2. The desktop app works too           ✎ ✕ ⋯
Also running
  Background command "unit suite": testing
✓ 4 done ▸
────────────────────────────────────────────
2 min ago · goals Opus · drift Haiku · observer: on · 🌐 English
```

**Marks**

| Mark | Meaning |
|---|---|
| `>` / `v` | the item has parts: press to show (`v`) or fold (`>`) its finished parts |
| `-` | the item has no parts |
| ○ | not done, not being worked on |
| ● | being worked on now (several at once is fine) |
| ◐ | a request with some of its parts done (`1/3`) |
| ✓ | done (green); finished parts fold under their request |

**Tags**

| Tag | Meaning |
|---|---|
| *seen in output* | ticked from the actual output of a test or report |
| *needs confirming* | written down from your words by the observer; Claude confirms it next |
| *may be out of date* | the work suggests it no longer applies; Claude re-plans it |
| *checked last* | true from the start ("X stays untouched"): ticked only once the rest is done |

**Now** (beside a ● part, or under the progress bar): *plan*, *investigate*, *editing*, *building*, *test*, *fix* (editing after a failed test), *review*, *thinking* (between tools), *waiting for your answer*, *waiting for your approval*. Nothing shows once the turn is over. **Also running** lists background commands and subagents until they really end.

**Buttons**: ✎ write an item in your own words (yours lead) · ✕ cancel it · ⋯ the words that asked for it and its evidence · ▶ start (build the list from the conversation) · ↻ refresh the AI side · ⌫ clear the list (two presses) · ✕ close (`/intents` reopens). Footer: the drift model (Haiku, Sonnet or Opus), *observer: on/off*, 🌐 language (English, 中文, 日本語 or your own).

## How it works

- **Only what you asked for.** A request must quote your own words; the mod checks the quote against the conversation (prompts, messages typed while Claude works, question-dialog answers), so Claude's own ideas and technical steps stay off the list. Claude breaks each request into plain-outcome parts; progress counts parts. Every item's check must be verifiable and falsifiable (a named test, command or behaviour that could come out wrong); "tests pass" or "works" is refused. "Don't touch X" is recorded as the goal "X stays untouched", marked *checked last*: it is true from the start, so neither Claude nor the observer can tick it until the rest is done. A small follow-up goes under the request it refines.
- **Recorded before the work.** Each message reminds Claude to put it on the list first, so you see it open before it is done.
- **Live status, no model.** *Now* comes from the actual tool calls; background work is checked every 5 seconds.
- **Observer.** A small model reads each result and each turn. It only adds: a tick when the line it quotes is really in the output and names that item (a suite-wide "68 pass" proves nothing), a *may be out of date* flag, and (at turn end) a request or change of mind Claude missed. Switch it off in the footer: no model call, nothing leaves the session.
- **Latest only, but your words are never lost.** Cancelled and replaced items leave the pane, except those holding words you wrote, which wait under a folded *Removed* section (restorable). Nothing Claude or the observer does can change your words; when two sessions write on the same item, both texts are kept, joined with "; ". Rewriting your own words replaces them, and every earlier version is kept in an append-only record.
- **Per worktree.** One shared list per project root, kept across sessions and kept in step between terminal and desktop sessions; concurrent changes are merged, not overwritten. A removed worktree's list is deleted at the next start.

## Where it runs

In the terminal and in the desktop app's Code tab, in sessions a person can see. A headless session (`claude -p`, the SDK) gets no pane, no instructions and no tools. Subagents and teammates cannot change the list.

## Install

```
/plugin install intent-tracker --marketplace GordanY/claude-intent-panel
```

Answer `y` to add the marketplace and choose the **user** scope. From a shell: `claude plugin install intent-tracker --marketplace GordanY/claude-intent-panel`. In the desktop app: **+** next to the prompt box → **Plugins** → **Add marketplace** `GordanY/claude-intent-panel` → **Add plugin**.

Update with `/plugin marketplace update claude-intent-panel`, then `/reload-plugins`. The pane opens by itself at about 144 columns; `/intents` opens it at any width. In the terminal, `ctrl+x tab` moves focus into the pane.

## Develop

```
claude plugin validate .
claude plugin test .
```
