# intent-tracker

A Claude Code mod: a side pane, **Goals**, that shows in plain words what you asked for in this session and how far it has got.

## The pane at a glance

```
Fix disappearing drafts                      ✎
▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 1/3
Also running
  Background command "unit suite": testing
────────────────────────────────────────────
╭──────────────────────────────────────────╮
│ > ◐ 1. Drafts never disappear 1/3  ✎ ✕ ⋯ │
│     ● 1b. Drafts survive switching       │
│           notebooks  now: testing        │
│     ○ 1c. Sync still works               │
╰──────────────────────────────────────────╯
╭──────────────────────────────────────────╮
│ - ○ 2. The desktop app works too   ✎ ✕ ⋯ │
╰──────────────────────────────────────────╯
────────────────────────────────────────────
✓ 4 done ▸
                   (room to spare)
────────────────────────────────────────────
↻ Refresh AI content  ⌫ Clear list  ✕ Close
────────────────────────────────────────────
2 min ago · goals Opus
drift Haiku  observer: on  🌐 English  ◐ dark
```

**Marks**

| Mark | Meaning |
|---|---|
| `>` / `v` | the item has parts: press it, or the item's words, to show (`v`) or fold (`>`) its finished parts |
| `-` | the item has no parts |
| ○ | not done, not being worked on |
| ● | being worked on now (several at once is fine) |
| ◐ | a request with some of its parts done (`1/3`) |
| ✓ | done (green); finished parts fold under their request |
| ⚠ | ticked, but the observer found nothing backing it (*evidence not matched*): not counted until it is ticked again or reopened |

**Tags**

| Tag | Meaning |
|---|---|
| *seen in output* | ticked from the actual output of a test or report |
| *confirmed by you* | ticked on your own words (your "yes" when asked about it) |
| *evidence not matched* | Claude ticked it, but nothing the turn showed backs that up; Claude reruns the check or reopens it |
| *check unclear* | no result could prove or disprove this check; Claude rewrites it |
| *your call* | only your answer can settle this one; Claude asks you |
| *needs confirming* | written down from your words by the observer; Claude confirms it next |
| *may be out of date* | the work suggests it no longer applies; Claude re-plans it |
| *checked last* | true from the start ("X stays untouched"): ticked only once the rest is done |

**Now** (beside a ● part, or under the progress bar): *plan*, *investigate*, *editing*, *building*, *test*, *fix* (editing after a failed test), *review*, *thinking* (between tools), *waiting for your answer*, *waiting for your approval*. Nothing shows once the turn is over. **Also running** lists background commands and subagents until they really end; one with no new output for ten minutes is drawn faded.

**Buttons**: ✎ write an item in your own words (yours lead) · ✕ cancel it · ⋯ the words that asked for it and its evidence · ▶ start (build the list from the conversation) · ↻ refresh the AI side · ⌫ clear the list (two presses) · ✕ close (`/intents` reopens). Under ✓ done, every finished request shows when the pane has room for them all, latest first; when it has not, the latest five (the rest behind *show all*). Long words wrap; nothing is cut short. A part's check shows while it is being worked on; ⋯ shows any other's. Open requests sit under an *In progress N* heading, each a card of its own, in the terminal and in the desktop app alike; dividers part the sections, wrapped words line up under the first word, and docked beside the transcript the tools and settings sit at the bottom edge (a long list pushes them down to the end of the scroll). Footer: when it last changed and the model that writes the list, then the settings on their own line: the drift model (Haiku, Sonnet or Opus), *observer: on/off*, 🌐 language (English, 中文, 日本語 or your own), ◐ colors (auto keeps your terminal's own look; dark or light paint the pane's background and give its text, buttons and progress bar colors that read on it).

## How it works

- **Only what you asked for.** A request must quote your own words; the mod checks the quote against the conversation (prompts, messages typed while Claude works, question-dialog answers), so Claude's own ideas and technical steps stay off the list. Claude breaks each request into plain-outcome parts; progress counts parts. Every item's check must be verifiable and falsifiable (a named test, command or behaviour that could come out wrong); "tests pass" or "works" is refused. "Don't touch X" is recorded as the goal "X stays untouched", marked *checked last*: it is true from the start, so neither Claude nor the observer can tick it until the rest is done. A small follow-up goes under the request it refines.
- **Recorded before the work.** Each message reminds Claude to put it on the list first, so you see it open before it is done.
- **Live status, no model.** *Now* comes from the actual tool calls; background work is checked every 5 seconds.
- **Observer.** A small model reads each message as you send it, each result, and each turn. It judges which result proves which item; the mod holds the floor: a tick needs a line really in the output that names something particular (a suite-wide "68 pass" proves nothing). It also audits Claude's own ticks (*evidence not matched*), reads each check once (*check unclear*, *your call*), ticks an item you were asked about when you say yes (*confirmed by you*: your words, verified), flags *may be out of date*, and catches a request or change of mind Claude missed. It only adds and flags; it never unticks. Switch it off in the footer: no model call, nothing leaves the session.
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
