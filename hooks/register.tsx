import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Actor, Drift, Intent, Purpose, Stage, StageKey } from '../types'
import { ago, asLang, DEFAULT_LANG, langLabel, langName, strings } from './i18n'
import type { Lang } from './i18n'
import {
  close,
  entry,
  labelOf,
  movePart,
  isDone,
  isLive,
  isRequest,
  kindOf,
  listText,
  nextId,
  normalize,
  midTurnTexts,
  partsOf,
  personTexts,
  resolveId,
  progress,
  advance,
  NO_STAGE,
  restore,
  said,
  stageOf,
  units,
  withHistory,
} from './model'

// A list belongs to a worktree (the session's project root), not to one CLI
// process: it is saved in $.store under `wt:<root>`, so quitting the CLI and
// resuming later, or opening another session in the same worktree, shows the
// same pane. $.state holds the live copy the pane draws from. When a
// worktree's folder is gone (its parent folder still there), the next start
// of the CLI deletes its list.

const P = 'intent-tracker'
const PANE = 'intents'
const TOOL = (name: string) => `mcp__${P}__${name}`
const KEY = 'wt:'

const intents = atom({ plugin: 'intent-tracker', key: 'intents' } as const, [] as Intent[], {
  shape: 'intents-1',
})
const purpose = atom({ plugin: 'intent-tracker', key: 'purpose' } as const, { ai: '', mine: '' } as Purpose, {
  shape: 'purpose-1',
})
const drift = atom({ plugin: 'intent-tracker', key: 'drift' } as const, null as Drift | null, {
  shape: 'drift-1',
})
const editing = atom({ plugin: 'intent-tracker', key: 'editing' } as const, null as string | null)
const isDirty = atom({ plugin: 'intent-tracker', key: 'isDirty' } as const, false)
const loadedRoot = atom({ plugin: 'intent-tracker', key: 'loadedRoot' } as const, null as string | null)
const isClosedByPerson = atom({ plugin: 'intent-tracker', key: 'isClosedByPerson' } as const, false)
const updatedAt = atom({ plugin: 'intent-tracker', key: 'updatedAt' } as const, null as number | null)
const now = atom({ plugin: 'intent-tracker', key: 'now' } as const, 0)
/** The person's language choice: saved in $.store, shared by every worktree and session. */
const lang = atom({ plugin: 'intent-tracker', key: 'lang' } as const, DEFAULT_LANG as Lang)
const LANG_KEY = 'settings:lang'
/** The drift check's model: saved in $.store, shared by every worktree and session. */
const driftModel = atom({ plugin: 'intent-tracker', key: 'driftModel' } as const, 'haiku' as string)
/**
 * Whether this session has a person who can see the pane: false for a `-p`
 * run, the SDK and other headless sessions, where the mod stays out of the way
 * (no instructions, no tools, no drift check).
 */
const isActive = atom({ plugin: 'intent-tracker', key: 'isActive' } as const, true)
/** The person's latest message is not on the list yet: Claude is reminded once more if it starts working first. */
const pendingRecord = atom({ plugin: 'intent-tracker', key: 'pendingRecord' } as const, false)

const RECORD_FIRST =
  `<intent-pane>If this message asks for something (a new request, a follow-up to an item, a change or a drop), record it on the list first (${TOOL('intent_add')} / ${TOOL('intent_revise')}), so the person sees it open before you start. A question is not a request.</intent-pane>`
const RECORDED_LATE =
  `<intent-pane>You started working without recording the person's latest message on the list. If it asks for something, record it now (${TOOL('intent_add')} / ${TOOL('intent_revise')}) before going on; if it is only a question, ignore this.</intent-pane>`

/** What the person typed in this session: prompts, mid-turn messages, dialog answers (the last 50). */
const heardSaid = atom({ plugin: 'intent-tracker', key: 'heardSaid' } as const, [] as { text: string; at: number }[])
const HEARD_MAX = 50

async function remember($: EngineInterface, texts: readonly string[]): Promise<void> {
  const kept = texts.map(text => text.trim()).filter(Boolean)
  if (kept.length === 0) return
  const at = await $.clock.now()
  await update($, heardSaid, old => [...old, ...kept.map(text => ({ text, at }))].slice(-HEARD_MAX))
}

/** Each active part's live activity, from the tool calls of whoever works on it. */
const activity = atom({ plugin: 'intent-tracker', key: 'activity' } as const, {} as Record<string, StageKey>)
/** Work still running beside the main loop, not shown on a part: background commands and subagents. */
const background = atom(
  { plugin: 'intent-tracker', key: 'background' } as const,
  {} as Record<string, { label: string; stage: StageKey; at: number; path?: string; lastOutputAt?: number }>,
)

/** How often running background work is checked against what Claude Code reports (no model). */
const RECONCILE_MS = 5_000
const ENDED: readonly string[] = ['completed', 'failed', 'killed']

/**
 * Checks running work against the facts, no model involved: subagents
 * against Claude Code's own list of them (an ended one leaves; a running one
 * not yet shown, say from before a reload, joins); background commands
 * against their output file (gone: it leaves; otherwise when it last wrote).
 */
async function reconcile($: EngineInterface): Promise<void> {
  const agents = await $.agent.list().catch(() => null)
  if (agents) {
    const byId = new Map(agents.map(agent => [agent.id, agent]))
    const isOver = (id: string) => {
      const agent = byId.get(id)
      return !agent || ENDED.includes(agent.status)
    }
    await update($, background, b =>
      Object.fromEntries(Object.entries(b).filter(([key]) => !key.startsWith('agent:') || !isOver(key.slice(6)))),
    )
    const links = await read($, agentLinks)
    const gone = Object.keys(links).filter(isOver)
    if (gone.length > 0) {
      await update($, agentLinks, l => Object.fromEntries(Object.entries(l).filter(([id]) => !gone.includes(id))))
      const still = new Set(Object.values(await read($, agentLinks)))
      await update($, activity, a => Object.fromEntries(Object.entries(a).filter(([part]) => still.has(part) || !gone.some(id => links[id] === part))))
    }
    const shown = await read($, background)
    const linked = await read($, agentLinks)
    const fresh = agents.filter(
      agent => ['pending', 'running', 'waiting'].includes(agent.status) && !shown[`agent:${agent.id}`] && !linked[agent.id],
    )
    if (fresh.length > 0) {
      const at = await $.clock.now()
      await update($, spawned, m => ({ ...m, ...Object.fromEntries(fresh.map(agent => [agent.id, agent.description])) }))
      await update($, background, b => ({
        ...b,
        ...Object.fromEntries(fresh.map(agent => [`agent:${agent.id}`, { label: shortLabel(agent.description), stage: 'think' as StageKey, at }])),
      }))
    }
  }

  const commands = Object.entries(await read($, background)).filter(([key]) => key.startsWith('cmd:'))
  if (commands.length === 0) return
  // Where each command writes: told to the model in its call's result ("Output is being written to: …").
  let texts: string[] | null = null
  for (const [key, item] of commands) {
    let path = item.path
    if (!path) {
      texts ??= (await $.session.messages().catch(() => [])).flatMap(m => m.toolUses.map(use => use.text ?? ''))
      const id = key.slice(4)
      const line = texts.find(text => text.includes(id) && text.includes('Output is being written to'))
      path = line?.match(/Output is being written to:\s*(\S+?\.output)/)?.[1]
      if (!path) continue
    }
    const info = await $.fs.stat(path).catch(() => null)
    if (!info) {
      await update($, background, b => without(b, key))
      continue
    }
    await update($, background, b => (b[key] ? { ...b, [key]: { ...b[key], path, lastOutputAt: info.mtimeMs } } : b))
  }
}
const without = <T,>(m: Record<string, T>, key: string): Record<string, T> => Object.fromEntries(Object.entries(m).filter(([k]) => k !== key))

/** A short name for a background item: a subagent's description without its leading [tag], or the command. */
function shortLabel(text: string): string {
  const plain = text.replace(/^\s*\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim()
  return plain.length > 32 ? `${plain.slice(0, 31)}…` : plain
}

/** Running subagents linked to a part: agent id → part id. */
const agentLinks = atom({ plugin: 'intent-tracker', key: 'agentLinks' } as const, {} as Record<string, string>)
/** Subagents started in this session: agent id → description. */
const spawned = atom({ plugin: 'intent-tracker', key: 'spawned' } as const, {} as Record<string, string>)
/** Claude's changes to parts this turn, told in one notice when the turn ends. */
const notes = atom({ plugin: 'intent-tracker', key: 'notes' } as const, [] as string[])

/** Queues a notice about Claude's change to parts; one notice per turn tells them all. */
async function note($: EngineInterface, what: 'added' | 'edited' | 'cancelled' | 'moved' | 'restored', parts: readonly Intent[]) {
  // Named by their words: labels shift as parts are added, cancelled and moved.
  const names = parts.map(one => {
    const text = one.mine || one.ai
    return text.length > 24 ? `${text.slice(0, 23)}…` : text
  })
  const text = strings(await read($, lang)).partsChanged(what, names)
  await update($, notes, old => [...old, text])
}

/** Whether a subagent's description is the one named for a part (its words, loosely). */
function isAgentFor(description: string, words: string): boolean {
  const a = normalize(description)
  const b = normalize(words)
  return b.length > 0 && (a.includes(b) || b.includes(a))
}

/**
 * Sets what is happening this instant for the loop that is acting: a linked
 * subagent's part, or the main loop (its stage line and the active parts no
 * subagent is on). A tool running shows its stage; between tools, thinking.
 */
async function setNow($: EngineInterface, agentId: string | undefined, step: StageKey): Promise<void> {
  if (agentId) {
    const partId = (await read($, agentLinks))[agentId]
    if (partId) await update($, activity, a => ({ ...a, [partId]: step }))
    else {
      const key = `agent:${agentId}`
      const at = await $.clock.now()
      const description = (await read($, spawned))[agentId] ?? ''
      await update($, background, b => ({ ...b, [key]: { label: shortLabel(description), stage: step, at } }))
    }
    return
  }
  const at = await $.clock.now()
  await update($, stage, old => (step === 'think' ? { ...old, now: step, at } : advance(old, step, at)))
  const linked = new Set(Object.values(await read($, agentLinks)))
  const mine = (await read($, intents)).filter(one => one.parent && isLive(one) && one.isActive && !one.isMet && !linked.has(one.id))
  if (mine.length > 0) await update($, activity, a => ({ ...a, ...Object.fromEntries(mine.map(one => [one.id, step])) }))
}

/** Where the work is now, from this session's own tool calls. */
const stage = atom({ plugin: 'intent-tracker', key: 'stage' } as const, NO_STAGE as Stage, { shape: 'stage-1' })
/** The item whose details (source, evidence) the pane shows; one at a time. */
const shownDetails = atom({ plugin: 'intent-tracker', key: 'shownDetails' } as const, null as string | null)
/** Whether the finished goals are expanded in the pane (folded by default). */
const isDoneOpen = atom({ plugin: 'intent-tracker', key: 'isDoneOpen' } as const, false)

/** A subagent's (or teammate's) call: only the main conversation edits the list. */
function fromSubagent(e: unknown): boolean {
  const agentId = (e as { agentId?: unknown }).agentId
  return typeof agentId === 'string' && agentId !== ''
}
const SUBAGENT_DENY = 'Only the main conversation updates the intent pane; leave it to the main agent.'

/** What the person themselves wrote: their prompts in this conversation and their words in the pane. */
async function heard($: EngineInterface): Promise<string[]> {
  const messages = await $.session.messages().catch(() => [])
  const p = await read($, purpose)
  const list = await read($, intents)
  const typed = (await read($, heardSaid)).map(one => one.text)
  return personTexts(messages, [p.mine, ...list.map(one => one.mine), ...typed])
}

/**
 * The models the drift check may run on, cheapest first; the person picks one
 * in the footer. The session's own model does the rest (goals and ticks are its
 * tool calls), so that one follows the session and is not picked here.
 */
const DRIFT_MODELS = ['haiku', 'sonnet', 'opus'] as const
const DEFAULT_DRIFT_MODEL = 'haiku'
const DRIFT_MODEL_KEY = 'settings:driftModel'

function asDriftModel(value: unknown): string {
  return typeof value === 'string' && (DRIFT_MODELS as readonly string[]).includes(value) ? value : DEFAULT_DRIFT_MODEL
}

/** How often a session re-reads the shared list for changes made elsewhere. */
const SYNC_MS = 2_000

const TOOLS = {
  add: TOOL('intent_add'),
  list: TOOL('intent_list'),
  met: TOOL('intent_met'),
  revise: TOOL('intent_revise'),
}

type Saved = { purpose: Purpose; intents: Intent[]; drift: Drift | null; updatedAt?: number }

const instructions = (language: string) => `# Intent pane (intent-tracker mod)
A pane beside the chat shows the person, in plain ${language}, what they asked for in this worktree and how far it has got, so they do not get lost when the conversation turns technical. The list is kept per worktree across sessions. Keep it accurate and quiet (do not narrate these calls).
What the list holds, in two layers:
- REQUESTS: only what the person asked for, never your own ideas or technical tasks. A goal is an outcome they want; a limit is something that must not be touched or broken WHILE the work is done ("don't touch sync", "keep the API the same"); a limit is never ticked, it holds or is broken. A request phrased in the negative about the result itself ("don't show X", "stop doing Y") is a goal, not a limit: it is done once the change is made. Each request carries \`source\`: the person's own words that asked for it, quoted exactly from their message (or their pane text); the tool refuses words the person never said. Work you suggest joins only once they say yes; then quote their yes.
- PARTS: break each goal request into the parts the person would recognise as pieces of what they asked: plain outcomes they can follow ("drafts survive closing the app", "sync still works"), never technical steps ("edit NoteStore.swift", "add a test"). Add them with \`parent\`: the request's id. A single request usually has several parts; progress counts parts, and a request is done when all its parts are. Revise the breakdown as you learn more (add parts, cancel ones that no longer apply).
- FOLLOW-UPS: a small follow-up that refines an existing request (a tweak to the same feature, "also make X…", "now make it Y") goes under that request as a part with its own \`source\` (the person's words), not as a new request; the request opens again until it is done. Only something that stands on its own is a new request.
- RECORD FIRST: when the person's message asks for something, record it before you start the work, so they see it open; never only after it is done.
- ORDER AND FOCUS: keep parts in the order they will be done (intent_revise position). Mark the parts being worked on now with ${TOOL('intent_revise')} active: true (any number at once; ticking a part ends it). When you send a subagent for a part, also give agent: "<words from that subagent's description>" so its activity shows on that part. Parts are yours to add, edit, reorder or cancel without asking; the person gets one notice per turn.
- SHAPE BY KIND OF WORK (parts are outcomes the person can follow, never steps): a bug → "it no longer happens" + "nothing else broke"; a new feature → each behaviour the person will see; a refactor → "it behaves the same" (a goal with a regression check); a question or investigation → "you have your answer" (ticked when you have answered it with evidence); docs or config → "the page/setting says X"; a release → each irreversible outcome in order ("the build is on TestFlight").
- RE-PLAN: when a part is marked STALE (the work shows it may no longer apply), or the root cause or approach changes, re-plan at once: edit, cancel or add parts so the list matches what is now true.
Adding: when the person states the task or adds to it, call ${TOOL('intent_add')} with a one-line \`purpose\` and the items. \`summary\`: one plain ${language} sentence a non-programmer understands (no file names, SHAs, flags or jargon); \`check\`: the concrete step that proves it (for a limit: how to see it still holds), identifiers allowed. Everything in ${language}. Never re-add an item already listed.
Ticking: ${TOOL('intent_met')} only after a goal's (or part's) check actually ran and passed, with the evidence; never on intent, partial work or an unrun check. If later work breaks a met one, ${TOOL('intent_revise')} reopen: true. A limit a result shows broken: ${TOOL('intent_revise')} broken: "<evidence>"; once it holds again, holding: true.
Changes of mind: when the person drops a request, ${TOOL('intent_revise')} cancel: "<their words>" (its parts close with it). When they change what they want, add the new request with \`replaces\`: "<old id>" and the new source; the old one stays on record as replaced, and a changed goal is verified afresh. A wording-only tweak: ${TOOL('intent_revise')} summary/check.
Keep the pane live: results that run a check (a test or build, a subagent's report, a background task's notification) carry an <intent-pane> note; act on it in the same step, before you reply or move on; ignore it when it does not apply.
An observer (a small model) reads each result and each turn. It ticks a goal or part the output shows passing (counted at once, shown as "seen in output"), marks a limit broken, and flags a part STALE when the work shows it no longer applies (re-plan it). At the end of a turn it may also record a request, a drop or a change of mind you missed, from the person's exact words; those show as "(auto, unconfirmed)": confirm with ${TOOL('intent_revise')} confirm: true, or undo (restore: true / cancel). It never unticks; reopen yourself when a later result breaks a met one.
To see the list, call ${TOOL('intent_list')}; never call another intent tool just to read it.
The person's own pane words are the authority: when your summary or check diverges from them, revise yours to match, never the reverse.`

const toolSpecs = [
  {
    name: 'intent_list',
    description: "Read the intent pane's current purpose and goals (ids, status, checks, the person's own words). Changes nothing.",
    inputSchema: { type: 'object', properties: {} },
    isDeferred: false,
  },
  {
    name: 'intent_add',
    description:
      "Add the person's requests (quoting their words) or the parts of a request to the intent pane, and optionally set the purpose. Use when the person states a task, adds to it or changes it.",
    inputSchema: {
      type: 'object',
      properties: {
        purpose: {
          type: 'string',
          description: "One plain line in the pane's language: what this work is for. Omit to keep the current one.",
        },
        intents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              summary: { type: 'string', description: "Plain sentence in the pane's language, no jargon." },
              check: { type: 'string', description: 'The concrete verification step that proves it (a limit: that it still holds).' },
              kind: { type: 'string', enum: ['goal', 'limit'], description: 'A request only: goal (default) or limit.' },
              source: {
                type: 'string',
                description:
                  "The person's own words that asked for it, quoted exactly from their message: required for a request; for a part, only when it is the person's follow-up to that request (leave it out for your own breakdown).",
              },
              parent: { type: 'string', description: 'A part: the id of the goal request it is a piece of ("+N": the Nth item of this call).' },
              replaces: {
                type: 'string',
                description: 'A request that replaces an earlier one because the person changed what they want: that id.',
              },
            },
            required: ['summary', 'check'],
          },
        },
      },
      required: ['intents'],
    },
    isDeferred: false,
  },
  {
    name: 'intent_met',
    description: "Tick a goal or part in the intent pane after its check actually ran and passed (a request with parts is ticked through its parts).",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The goal or part, by id or label ("1b").' },
        evidence: {
          type: 'string',
          description: "Short note, in the pane's language, of what was run or observed (test name, behaviour seen).",
        },
      },
      required: ['id', 'evidence'],
    },
    isDeferred: false,
  },
  {
    name: 'intent_revise',
    description:
      "Change the purpose line or an item: its wording, reopen a met one, cancel a request the person dropped (their words) or a part that no longer applies, restore a closed one, mark a limit broken or holding, or confirm an auto entry. Never touches the person's own words.",
    inputSchema: {
      type: 'object',
      properties: {
        purpose: { type: 'string', description: "New plain purpose line in the pane's language." },
        id: { type: 'string', description: 'The item to change, by id or label ("1b"); omit when changing only the purpose.' },
        summary: { type: 'string' },
        check: { type: 'string' },
        reopen: { type: 'boolean', description: 'A met goal or part whose check no longer holds.' },
        cancel: {
          type: 'string',
          description:
            "Close it. A request: the person's own words dropping it, quoted exactly (its parts close with it). A part: why it no longer applies.",
        },
        restore: { type: 'boolean', description: 'Bring back a cancelled or replaced item (with the parts that closed with it).' },
        broken: { type: 'string', description: 'A limit: the evidence that it was broken.' },
        holding: { type: 'boolean', description: 'A limit that holds again.' },
        confirm: { type: 'boolean', description: 'Confirm an auto (unconfirmed) cancel, replace, broken or added entry.' },
        active: { type: 'boolean', description: 'A part: being worked on now (true) or not (false). Any number may be active.' },
        agent: { type: 'string', description: "A part: words from the description of the subagent sent for it (its activity shows on the part)." },
        position: { type: 'number', description: "A part: move it to this 1-based place among its request's parts." },
      },
    },
    isDeferred: false,
  },
] as const

/**
 * Bash commands whose output usually runs a goal's check: tests, builds,
 * linters, type-checks, verification scripts, CI status.
 */
const VERIFY_COMMAND =
  /\b(test|tests|spec|build|lint|check|verify|validate|xcodebuild|pytest|jest|vitest|mocha|tsc|cargo|go\s+(test|vet|build)|make|gradle|mvn|swift\s+(test|build)|npm\s+(run|test)|pnpm|yarn|bun|rspec|rake|merge-check|gh\s+(pr|run)\s+(checks|view|watch))\b/i

/** Of those, the ones that test or verify (the rest only build). */
const TEST_COMMAND =
  /\b(test|tests|spec|pytest|jest|vitest|mocha|rspec|lint|check|verify|validate|tsc|merge-check)\b|gh\s+(pr|run)\s+(checks|view|watch)/i

/** Tools whose finished result is someone else's report: a subagent's, a workflow's, a background task's. */
const REPORT_TOOLS = new Set(['Agent', 'Task', 'Workflow', 'TaskOutput'])

/**
 * Whether a finished tool call is a result worth checking the goals against.
 * A call started in the background has no result yet: its notification is
 * handled when it arrives.
 */
function isResult(e: Record<string, unknown>): boolean {
  if (e.run_in_background === true) return false
  if (REPORT_TOOLS.has(String(e.tool))) return true
  return e.tool === 'Bash' && typeof e.command === 'string' && VERIFY_COMMAND.test(e.command)
}

/** The note beside a result: what is still open, and what to do if the result settles one. */
function resultNote(list: readonly Intent[]): string | null {
  const open = units(list).filter(one => !one.isMet)
  const limits = list.filter(one => isLive(one) && kindOf(one) === 'limit')
  if (open.length === 0 && limits.length === 0) return null
  const lines = ['<intent-pane>A result just arrived. If it runs one of these checks, update the pane now, before going on:']
  for (const one of open) {
    const label = labelOf(list, one)
    lines.push(`${label}. [open${one.isStale ? ', STALE: re-plan' : ''}] ${one.mine || one.ai} | check: ${one.check || '(none)'}`)
  }
  for (const one of limits) {
    lines.push(`${one.id}. [limit · ${one.broken ? 'BROKEN' : 'holding'}] ${one.mine || one.ai} | check: ${one.check || '(none)'}`)
  }
  lines.push(
    `Passed → ${TOOL('intent_met')} with the evidence. Broke a met one → ${TOOL('intent_revise')} reopen: true. ` +
      `Shows a limit broken → ${TOOL('intent_revise')} broken: "<evidence>". Unrelated → ignore this note.</intent-pane>`,
  )
  return lines.join('\n')
}

const TOOLBAR_GAP = 2

/** A hairline as wide as its slot, mid-grey at partial opacity so it reads on light and dark. */
const RULE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1" viewBox="0 0 2000 1" preserveAspectRatio="none">' +
  '<rect width="2000" height="1" fill="#808080" fill-opacity="0.35"/></svg>'

/** A progress bar as wide as its slot: a light track and the done share over it. */
function progressSvg(share: number): string {
  const done = Math.round(Math.max(0, Math.min(1, share)) * 2000)
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="6" viewBox="0 0 2000 6" preserveAspectRatio="none">' +
    '<rect width="2000" height="6" rx="3" fill="#808080" fill-opacity="0.25"/>' +
    (done > 0 ? `<rect width="${done}" height="6" rx="3" fill="#4caf50"/>` : '') +
    '</svg>'
  )
}

/** Terminal cells a label takes: East Asian wide characters count two. */
function cells(text: string): number {
  let n = 0
  for (const ch of text) n += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1
  return n
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asSaved(value: unknown): Saved | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Partial<Saved>
  if (!Array.isArray(v.intents) || typeof v.purpose !== 'object' || v.purpose === null) return null
  return {
    purpose: v.purpose,
    intents: v.intents,
    drift: v.drift ?? null,
    ...(typeof v.updatedAt === 'number' ? { updatedAt: v.updatedAt } : {}),
  }
}

/** "claude-opus-5-5" → "Opus 5.5"; "haiku" → "Haiku"; anything else as given. */
function modelName(id: string): string {
  const m = id.match(/(opus|sonnet|haiku|fable)(?:-(\d+)(?:[-.](\d+))?)?/i)
  if (!m || !m[1]) return id
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()
  const version = m[2] ? ` ${m[2]}${m[3] ? `.${m[3]}` : ''}` : ''
  return family + version
}

/**
 * Keeps the pane's title (met/total) current. An open pane is retitled; a
 * closed one is opened only when the person asks, or when they have not
 * closed it by hand in this session.
 */
async function refreshTitle($: EngineInterface, isAsked = false): Promise<void> {
  if (isAsked) await update($, isClosedByPerson, () => false)
  const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (!isUp && !isAsked && (await read($, isClosedByPerson))) return
  const { met, total } = progress(await read($, intents))
  const t = strings(await read($, lang))
  const title = total === 0 ? t.title : `${t.title} ${met}/${total}`
  await $.ui.open({ id: PANE, title })
}

/**
 * Brings the live list in line with the saved one, the single source of truth.
 * The store is one file shared by every session on this machine (terminal and
 * desktop alike), so another session in the same worktree may have changed it:
 * a newer saved copy is adopted, and reaches the model beside the next prompt.
 * Every change reads first (here) and writes straight after (`save`).
 */
async function sync($: EngineInterface): Promise<void> {
  const root = await $.session.root()
  const prev = await read($, loadedRoot)
  if (prev === root) {
    const saved = asSaved(await $.store.get(KEY + root))
    const localAt = await read($, updatedAt)
    // Same stamp: nothing changed elsewhere. A missing copy with a local stamp
    // means another session cleared the list.
    if ((saved?.updatedAt ?? null) === localAt) return
    if (!saved && localAt === null) return
    await update($, purpose, () => saved?.purpose ?? { ai: '', mine: '' })
    await update($, intents, () => saved?.intents ?? [])
    await update($, drift, () => saved?.drift ?? null)
    await update($, updatedAt, () => saved?.updatedAt ?? null)
    await update($, isDirty, () => true)
    await refreshTitle($)
    return
  }
  const saved = asSaved(await $.store.get(KEY + root))
  // A live list from before lists were saved (a hot reload of an older
  // version) is adopted for this worktree, not wiped.
  if (!saved && prev === null && ((await read($, intents)).length > 0 || (await read($, purpose)).ai)) {
    await update($, loadedRoot, () => root)
    await save($)
    await refreshTitle($)
    return
  }
  await update($, purpose, () => saved?.purpose ?? { ai: '', mine: '' })
  await update($, intents, () => saved?.intents ?? [])
  await update($, drift, () => saved?.drift ?? null)
  await update($, updatedAt, () => saved?.updatedAt ?? null)
  await update($, editing, () => null)
  // A list carried over from an earlier session reaches the model at the next prompt.
  await update($, isDirty, () => (saved?.intents.length ?? 0) > 0)
  await update($, loadedRoot, () => root)
  await refreshTitle($)
}

/** Writes the live list back under the worktree it was loaded for. */
async function save($: EngineInterface): Promise<void> {
  const root = await read($, loadedRoot)
  if (!root) return
  const at = await $.clock.now()
  await update($, updatedAt, () => at)
  await update($, now, () => at)
  const data: Saved = {
    purpose: await read($, purpose),
    intents: [...(await read($, intents))],
    drift: await read($, drift),
    updatedAt: at,
  }
  if (data.intents.length === 0 && !data.purpose.ai && !data.purpose.mine) await $.store.delete(KEY + root)
  else await $.store.set(KEY + root, data)
}

async function exists($: EngineInterface, path: string): Promise<boolean> {
  return $.fs.stat(path).then(
    () => true,
    () => false,
  )
}

/** Deletes the lists of worktrees whose folder was removed. */
async function sweep($: EngineInterface): Promise<void> {
  for (const key of await $.store.keys()) {
    if (!key.startsWith(KEY)) continue
    const path = key.slice(KEY.length)
    if (await exists($, path)) continue
    const parent = path.replace(/[\\/]+[^\\/]+[\\/]*$/, '') || '/'
    // Parent there but the folder gone: the worktree was removed. Parent gone
    // too (an unmounted disk): keep the list.
    if (await exists($, parent)) await $.store.delete(key)
  }
}

type Quoted = { id: string; quote: string; summary: string; check: string; evidence: string; kind: 'goal' | 'limit'; parent: string }

type Verdict = {
  isOnTrack: boolean
  note: string
  isByUser: boolean
  met: Quoted[]
  broken: Quoted[]
  stale: Quoted[]
  cancel: Quoted[]
  replace: Quoted[]
  add: Quoted[]
}

function parseVerdict(text: string): Verdict | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const value = JSON.parse(match[0]) as Record<string, unknown>
    const rows = (key: string): Quoted[] =>
      (Array.isArray(value[key]) ? (value[key] as unknown[]) : [])
        .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
        .map(m => ({
          id: str(String(m.id ?? '')),
          quote: str(m.quote),
          summary: str(m.summary),
          check: str(m.check),
          evidence: str(m.evidence ?? m.why),
          kind: m.kind === 'limit' ? ('limit' as const) : ('goal' as const),
          parent: str(String(m.parent ?? '')),
        }))
    return {
      isOnTrack: value.onTrack !== false,
      note: str(value.note),
      isByUser: value.byUser === true,
      met: rows('met').filter(m => m.id && m.evidence),
      broken: rows('broken').filter(m => m.id && m.evidence),
      stale: rows('stale').filter(m => m.id),
      cancel: rows('cancel').filter(m => m.id && m.quote),
      replace: rows('replace').filter(m => m.id && m.quote && m.summary),
      add: rows('add').filter(m => m.quote && m.summary),
    }
  } catch {
    return null
  }
}

/** How much of each tool's output, and of all of them, the observer reads. */
const OUTPUT_EACH = 1200
const OUTPUT_ALL = 14000

/** How long the observer waits after a result before reading, so a burst of results is read once. */
const OBSERVE_DEBOUNCE_MS = 4_000
const observeAt = atom({ plugin: 'intent-tracker', key: 'observeAt' } as const, 0)
/** How far into the conversation the observer has read tool output (message count). */
const observed = atom({ plugin: 'intent-tracker', key: 'observed' } as const, 0)

/** A result arrived: read the new output shortly (one pass for a burst). */
function observeSoon($: EngineInterface): void {
  void (async () => {
    const at = (await $.clock.now()) + OBSERVE_DEBOUNCE_MS
    await update($, observeAt, () => at)
    $.clock.after(OBSERVE_DEBOUNCE_MS, () => {
      void (async () => {
        if ((await $.clock.now()) < (await read($, observeAt))) return
        await checkTurn($, 0, 'result')
      })().catch(() => undefined)
    })
  })().catch(() => undefined)
}

/**
 * The observer: a small model reads what is new in the conversation against
 * the list. It only ever adds: ticks (confirmed, as they quote output),
 * broken limits, stale flags; at the end of a turn also drift, and from the
 * person's latest words a missed request, drop or change (those wait for
 * Claude to confirm). It never unticks, reopens, or edits the plan, and every
 * quote is checked against the person's words.
 */
async function checkTurn($: EngineInterface, durationMs = 0, mode: 'turn' | 'result' = 'turn'): Promise<void> {
  const list = await read($, intents)
  const p = await read($, purpose)
  if (mode === 'result' && units(list).every(one => one.isMet) && !list.some(one => isLive(one) && kindOf(one) === 'limit')) return

  const messages = await $.session.messages()
  let start = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m && m.role === 'user' && m.text.trim() !== '' && !(m.toolResults && m.toolResults.length > 0)) {
      start = i
      break
    }
  }
  const asked = messages[start]
  if (!asked) return
  // A notification or the pane's own prompt is no word of the person's.
  // Words they typed while the turn ran (queued over it) count too.
  const turnStart = (await $.clock.now()) - durationMs - 1_000
  const midTurn =
    mode === 'turn'
      ? [
          ...new Set([
            ...messages.slice(start + 1).flatMap(m => (m.role === 'user' ? midTurnTexts(m.text) : [])),
            ...(await read($, heardSaid)).filter(one => one.at >= turnStart && one.text !== asked.text.trim()).map(one => one.text),
          ]),
        ]
      : []
  const personWords = [...personTexts([asked], []), ...midTurn]

  const ask = [asked.text, ...midTurn].join('\n').slice(0, 2000)
  // Output already read by an earlier pass is not read again.
  const seenUpTo = await read($, observed)
  const from = Math.max(start + 1, seenUpTo > messages.length ? 0 : seenUpTo)
  const work: string[] = []
  const outputs: string[] = []
  let outputLength = 0
  // What Claude itself changed this turn: the observer leaves those to it.
  const touchedIds = new Set<string>()
  const addedSources: string[] = []
  messages.slice(start + 1).forEach((m, n) => {
    if (m.role !== 'assistant') return
    if (m.text.trim()) work.push(`said: ${m.text.trim().slice(0, 600)}`)
    for (const use of m.toolUses) {
      if (use.tool === TOOLS.revise) touchedIds.add(str(use.input.id))
      if (use.tool === TOOLS.add && Array.isArray(use.input.intents)) {
        for (const item of use.input.intents as Record<string, unknown>[]) if (str(item.source)) addedSources.push(normalize(str(item.source)))
      }
      if (use.tool.startsWith(`mcp__${P}__`)) continue
      work.push(`${use.tool}: ${JSON.stringify(use.input).slice(0, 300)}`)
      const out = (use.text ?? '').trim()
      if (start + 1 + n < from || !out || outputLength >= OUTPUT_ALL) continue
      // The tail of a long output is where a test run's summary is.
      const kept = out.length > OUTPUT_EACH ? `…${out.slice(-OUTPUT_EACH)}` : out
      const entry = `--- ${use.tool} ${JSON.stringify(use.input).slice(0, 160)}${use.isError ? ' (error)' : ''}\n${kept}`
      outputs.push(entry)
      outputLength += entry.length
    }
  })
  await update($, observed, () => messages.length)
  if (mode === 'result' && outputs.length === 0) return
  if (work.length === 0 && personWords.length === 0) return
  if (list.length === 0 && personWords.length === 0) return

  const language = langName(await read($, lang))
  const isTurn = mode === 'turn'
  const answer = await $.model.complete({
    model: await read($, driftModel),
    maxTokens: 700,
    system:
      "You check an AI coding assistant's work against the list of what a person asked for. Reply with JSON only.",
    prompt:
      `${list.length > 0 ? listText(p, list) : 'The list is empty.'}\n\n` +
      `The person's latest message${personWords.length === 0 ? ' (an automatic notification, not the person)' : ''}:\n${ask}\n\n` +
      `What the assistant did this turn:\n${work.join('\n').slice(0, 8000) || '(nothing)'}\n\n` +
      (outputs.length > 0 ? `What the tools returned (new since the last check; tails of long outputs):\n${outputs.join('\n')}\n\n` : '') +
      'The list holds only what the person asked for: requests (a goal, or a limit: something that must not happen), and parts (pieces of a goal request, labelled like 1a). Answer each question; when unsure, leave it out.\n' +
      "1. met: open goals or parts (not limits, not requests that have parts) whose check a tool output above actually ran and showed passing: a passing test summary, a successful build line, a report stating the check passed. Never on a plan, the assistant's claim, a partial run, or an output with failures.\n" +
      '2. broken: live limits a tool output shows broken.\n' +
      '3. stale: open parts the work shows no longer apply (the approach or root cause changed, the part is superseded or moot).\n' +
      (isTurn
        ? '4. drift: work clearly unrelated to every item and to the purpose, that the person did not ask for. Investigation, setup, verification and fixing what blocks an item are on track.\n' +
          "5. From the person's latest message only (skip if it is a notification), and only what the list does not already show:\n" +
          '   add: something they asked for that is no item yet: an outcome they want (kind goal), or something that must not be touched or broken while the work is done (kind limit). A negative request about the result itself ("don\'t show X") is a goal. Not a question, not thanks, not approval of a step already listed.\n' +
          '   cancel: a request they dropped ("never mind X", "skip X").\n' +
          '   replace: a request they changed into something else ("instead of X, do Y").\n' +
          '   Each needs "quote": their exact words from that message.\n'
        : '') +
      'Reply with one JSON object, empty lists where nothing applies: {' +
      (isTurn ? `"onTrack": true|false, "note": "<when off track: one short plain sentence in ${language} naming the off-list work, no jargon>", ` : '') +
      `"met": [{"id": "<id>", "evidence": "<one short line in ${language} naming the output that shows the pass, quoting its key line>"}], ` +
      `"broken": [{"id": "<limit id>", "evidence": "<one short line in ${language}>"}], ` +
      `"stale": [{"id": "<part id>", "why": "<one short line in ${language}>"}]` +
      (isTurn
        ? `, "add": [{"quote": "<their exact words>", "kind": "goal"|"limit", "parent": "<request id, only when it is a small follow-up refining that request>", "summary": "<one plain sentence in ${language}, no jargon>", "check": "<how to prove it, in ${language}>"}], ` +
          '"cancel": [{"id": "<request id>", "quote": "<their exact words>"}], ' +
          `"replace": [{"id": "<request id>", "quote": "<their exact words>", "summary": "<the new request, plain ${language}>", "check": "<how to prove it>"}]`
        : '') +
      '}',
  })
  if (!answer.isAnswered) return

  const verdict = parseVerdict(answer.text)
  if (!verdict) return
  if (!isTurn) {
    verdict.isOnTrack = true
    verdict.cancel = []
    verdict.replace = []
    verdict.add = []
  }
  // Read the shared copy first: another session may have changed it meanwhile.
  await sync($)
  const t = strings(await read($, lang))
  const at = await $.clock.now()
  const done: string[] = []
  let isChanged = false
  if (!verdict.isOnTrack && verdict.note && list.length > 0) {
    await update($, drift, () => ({ note: verdict.note, isByUser: verdict.isByUser }))
    isChanged = true
  }

  const current = await read($, intents)
  const byId = (ref: string) => {
    const id = resolveId(current, ref)
    return id ? current.find(one => one.id === id) : undefined
  }
  const isHeard = (quote: string) => said(personWords, quote)
  const open = new Set(units(current).filter(one => !one.isMet).map(one => one.id))
  const pick = (rows: Quoted[], ok: (one: Intent, m: Quoted) => boolean) =>
    rows.flatMap(m => {
      const one = byId(m.id)
      return one && ok(one, m) ? [{ ...m, id: one.id }] : []
    })
  const ticks = pick(verdict.met, one => open.has(one.id))
  const breaks = pick(verdict.broken, one => isLive(one) && kindOf(one) === 'limit' && !one.broken)
  const stales = pick(verdict.stale, one => isLive(one) && !!one.parent && !one.isMet && !one.isStale)
  // Items Claude itself changed this turn are left to it.
  const cancels = pick(verdict.cancel, (one, m) => isLive(one) && isRequest(one) && !touchedIds.has(one.id) && isHeard(m.quote))
  const replaces = pick(
    verdict.replace,
    (one, m) => isLive(one) && isRequest(one) && !touchedIds.has(one.id) && isHeard(m.quote) && !cancels.some(c => c.id === one.id),
  )
  // A request already on the list, or just added by Claude from the same words, is not added twice.
  const known = [
    ...current.filter(one => isRequest(one) || one.source).flatMap(one => [one.source ?? '', one.ai, one.mine].map(normalize)),
    ...addedSources,
  ]
  const adds = verdict.add.filter(m => {
    const quote = normalize(m.quote)
    return isHeard(m.quote) && !known.some(k => k && (k.includes(quote) || quote.includes(k)))
  })

  if (ticks.length + breaks.length + stales.length + cancels.length + replaces.length + adds.length > 0) {
    await update($, intents, l => {
      let next = l.map(one => {
        const tick = ticks.find(m => m.id === one.id)
        // Seen in the output it quotes: counted at once, no confirming needed.
        if (tick) {
          return withHistory(
            { ...one, isMet: true, evidence: tick.evidence, isAuto: true, isActive: false, isStale: false },
            entry(at, 'auto', 'met', tick.evidence),
          )
        }
        const brk = breaks.find(m => m.id === one.id)
        if (brk) return withHistory({ ...one, broken: { evidence: brk.evidence, at } }, entry(at, 'auto', 'broken', brk.evidence))
        if (stales.some(m => m.id === one.id)) return { ...one, isStale: true }
        return one
      })
      for (const c of cancels) next = close(next, c.id, { as: 'cancelled', reason: c.quote, by: 'person', at, isAuto: true })
      let n = nextId(next)
      const fresh = (m: Quoted): Intent => {
        // A small follow-up to a live goal request goes under it, with the person's words.
        const parentId = m.parent ? resolveId(next, m.parent) : undefined
        const parent = parentId ? next.find(one => one.id === parentId && isLive(one) && isRequest(one) && kindOf(one) === 'goal') : undefined
        return {
          id: String(n++),
          ai: m.summary,
          mine: '',
          check: m.check,
          isMet: false,
          evidence: '',
          isAuto: true,
          source: m.quote,
          history: [entry(at, 'auto', 'added', m.quote)],
          ...(parent ? { parent: parent.id } : { kind: m.kind }),
        }
      }
      for (const r of replaces) {
        const added = fresh(r)
        next = [...next, added].map(one => (one.parent === r.id && isLive(one) ? { ...one, parent: added.id } : one))
        next = close(next, r.id, { as: 'replaced', reason: r.quote, by: 'person', at, replacedBy: added.id, isAuto: true })
      }
      for (const a of adds) next = [...next, fresh(a)]
      return next
    })
    const labels = (rows: { id: string }[]) => {
      const now = current
      return rows.map(m => {
        const one = now.find(x => x.id === m.id)
        return one ? labelOf(now, one) : m.id
      })
    }
    if (ticks.length > 0) done.push(t.autoTicked(labels(ticks)))
    if (breaks.length > 0) done.push(t.autoBroken(labels(breaks)))
    if (stales.length > 0) done.push(t.autoStale(labels(stales)))
    if (cancels.length > 0) done.push(t.autoCancelled(labels(cancels)))
    if (replaces.length > 0) done.push(t.autoReplaced(labels(replaces)))
    if (adds.length > 0) done.push(t.autoAdded(adds.length))
    // Claude reads the new state beside the next prompt (and stale parts beside the next result).
    await update($, isDirty, () => true)
    isChanged = true
    $.ui.toast(t.toastAuto(done))
  }
  if (!isChanged) return
  await save($)
  await refreshTitle($)
}

/**
 * Turns the mod on for a session a person can see: tools, `/intents`, the
 * shared list and its timers. Runs once per load, at start under the REPL, or
 * when a surface first attaches (the desktop app's Code tab hosts its session
 * through the SDK, so it starts with no surface and attaches one after).
 */
async function activate($: EngineInterface): Promise<void> {
  if (await read($, isActive)) return
  await update($, isActive, () => true)
  for (const spec of toolSpecs) await $.tool.register(spec)
  const chosen = asLang(await $.store.get(LANG_KEY))
  const stored = asDriftModel(await $.store.get(DRIFT_MODEL_KEY))
  await update($, driftModel, () => stored)
  await update($, lang, () => chosen)
  await $.command.register({ name: 'intents', description: strings(chosen).command })
  await sweep($).catch(() => undefined)
  await sync($)
  // "N 分鐘前" in the footer: the pane redraws once a minute (a reload
  // cancels this timer and session.start starts a new one).
  const at = await $.clock.now()
  await update($, now, () => at)
  $.clock.every(60_000, () => {
    void $.clock.now().then(t => update($, now, () => t))
  })
  // Running background work, checked against the facts every few seconds.
  $.clock.every(RECONCILE_MS, () => {
    void reconcile($).catch(() => undefined)
  })
  // Another session in this worktree (a terminal beside the desktop app, or
  // the reverse) may change the shared list or language: pick it up.
  $.clock.every(SYNC_MS, () => {
    void (async () => {
      await sync($)
      const shared = asLang(await $.store.get(LANG_KEY))
      if (JSON.stringify(shared) !== JSON.stringify(await read($, lang))) {
        await update($, lang, () => shared)
        await refreshTitle($)
      }
      const sharedModel = asDriftModel(await $.store.get(DRIFT_MODEL_KEY))
      if (sharedModel !== (await read($, driftModel))) await update($, driftModel, () => sharedModel)
    })().catch(() => undefined)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A reload runs this again: start from off so activate registers anew.
    await update($, isActive, () => false)
    if (e.isInteractive || (await $.session.surfaces()).length > 0) await activate($)

    return next(e)
  })

  // A `-p` run never attaches a surface, so it stays off: no pane, no tools.
  on('session.attach', async ($, e, next) => {
    await activate($)

    return next(e)
  })

  on('command.run', { command: 'intents' }, async $ => {
    await sync($)
    await refreshTitle($, true)

    return { text: strings(await read($, lang)).opened }
  })

  // Closed by the person: list changes stop reopening it until they ask again.
  // (This mod never closes its own pane, so any close but an unload is theirs.)
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind !== 'unload') await update($, isClosedByPerson, () => true)

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    // Only where a person can see the pane: not headless, not a teammate's prompt.
    const isShown = (await read($, isActive)) && e.surfaces.length > 0 && !e.traits.includes('teammate')
    if (!isShown) return composed

    return {
      sections: [
        ...composed.sections,
        { id: `${P}:instructions`, text: instructions(langName(await read($, lang))), scope: 'session' as const },
      ],
    }
  })

  // The list reaches the model beside the next prompt after the person edits
  // their words, or when it was carried over from an earlier session.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || !(await read($, isActive))) return next(e)
    // The person's own words, typed at the prompt or over a running turn:
    // what a request's source is checked against.
    if (!e.isMeta && !/^\s*(\(Goals pane\)|（目標面板）|（目標パネル）)/.test(e.text)) await remember($, [e.text])
    if (e.isMeta) {
      // A background task's (or subagent's) notification is a result arriving:
      // the open goals ride beside it, as they do beside a finished tool call.
      if (!/<task-notification\b/.test(e.text)) return next(e)
      // Its background command is done: no longer running.
      for (const m of e.text.matchAll(/<task-id>([^<]+)<\/task-id>/g)) {
        const key = `cmd:${(m[1] ?? '').trim()}`
        await update($, background, b => without(b, key))
      }
      await sync($)
      const note = resultNote(await read($, intents))
      return next(note ? { ...e, context: [...(e.context ?? []), note] } : e)
    }
    await sync($)
    // The pane's own prompts (start, refresh) are not a request to record.
    const isPerson = !/^\s*(\(Goals pane\)|（目標面板）|（目標パネル）)/.test(e.text)
    if (isPerson) await update($, pendingRecord, () => true)
    const context = [...(e.context ?? []), ...(isPerson ? [RECORD_FIRST] : [])]
    if (!(await read($, isDirty))) return next({ ...e, context })
    const block = `<intent-pane>\nThe intent pane for this worktree (the person's words are authoritative). Current list:\n${listText(
      await read($, purpose),
      await read($, intents),
    )}\n</intent-pane>`
    await update($, isDirty, () => false)

    return next({ ...e, context: [...context, block] })
  })

  on('tool.call', { tool: 'mcp__intent-tracker__intent_add' }, async ($, e) => {
    if (fromSubagent(e)) return { deny: SUBAGENT_DENY }
    await update($, pendingRecord, () => false)
    await sync($)
    const args = e as unknown as Record<string, unknown>
    const given = Array.isArray(args.intents) ? (args.intents as Record<string, unknown>[]) : []
    const newPurpose = str(args.purpose)
    const list = await read($, intents)
    const first = nextId(list)
    const items = given
      .map(g => ({
        summary: str(g.summary),
        check: str(g.check),
        kind: g.kind === 'limit' ? ('limit' as const) : ('goal' as const),
        source: str(g.source),
        parent: str(g.parent),
        replaces: str(g.replaces),
      }))
      .filter(g => g.summary)
      .map((g, n) => ({ ...g, id: String(first + n) }))
    // "+N" names the Nth item of this same call, so a request and its parts go in together.
    const parentOf = (ref: string) => (/^\+\d+$/.test(ref) ? String(first + Number(ref.slice(1)) - 1) : (resolveId(list, ref) ?? ref))
    const kindOfRequest = (id: string): 'goal' | 'limit' | undefined => {
      const fresh = items.find(item => item.id === id && !item.parent)
      if (fresh) return fresh.kind
      const one = list.find(x => x.id === id && isLive(x) && isRequest(x))
      return one ? kindOf(one) : undefined
    }
    const texts = await heard($)
    const problems: string[] = []
    items.forEach((item, n) => {
      const at = `item ${n + 1} ("${item.summary.slice(0, 40)}")`
      if (item.parent) {
        const kind = kindOfRequest(parentOf(item.parent))
        if (!kind) problems.push(`${at}: parent "${item.parent}" is not a live request on the list.`)
        else if (kind === 'limit') problems.push(`${at}: a limit has no parts.`)
        if (item.kind === 'limit') problems.push(`${at}: a part is always a goal; a limit is a request of its own, quoting the person.`)
        if (item.replaces) problems.push(`${at}: replaces is for requests, not parts.`)
        // The person's own follow-up to that request carries their words, checked like a request's.
        if (item.source && !said(texts, item.source)) {
          problems.push(`${at}: the person never said "${item.source}". Quote their words exactly, or leave source out for your own breakdown.`)
        }
        return
      }
      if (!item.source) {
        problems.push(
          `${at}: a request needs source, the person's own words that asked for it. If this is your own idea or a technical step, it does not go on the list (a step of a request is a part: give parent instead).`,
        )
      } else if (!said(texts, item.source)) {
        problems.push(
          `${at}: the person never said "${item.source}". Quote their words exactly as they wrote them (an ellipsis may join two pieces of one message).`,
        )
      }
      const old = item.replaces ? resolveId(list, item.replaces) : undefined
      if (item.replaces && !list.some(one => one.id === old && isLive(one) && isRequest(one))) {
        problems.push(`${at}: replaces "${item.replaces}" is not a live request on the list.`)
      }
    })
    if (problems.length > 0) {
      return { deny: `Nothing was added.\n${problems.join('\n')}\n\n${listText(await read($, purpose), list)}` }
    }

    const at = await $.clock.now()
    if (newPurpose) await update($, purpose, p => ({ ...p, ai: newPurpose }))
    await update($, intents, current => {
      let next = [...current]
      for (const item of items) {
        const added: Intent = {
          id: item.id,
          ai: item.summary,
          mine: '',
          check: item.check,
          isMet: false,
          evidence: '',
          history: [entry(at, 'claude', 'added', item.source || undefined)],
          ...(item.parent
            ? { parent: parentOf(item.parent), ...(item.source ? { source: item.source } : {}) }
            : { kind: item.kind, source: item.source }),
        }
        next.push(added)
        const old = item.replaces ? resolveId(current, item.replaces) : undefined
        if (old) {
          // The parts that still apply carry over to the new request; Claude cancels the rest.
          next = next.map(one => (one.parent === old && isLive(one) ? { ...one, parent: item.id } : one))
          next = close(next, old, { as: 'replaced', reason: item.source, by: 'person', at, replacedBy: item.id })
        }
      }
      return next
    })
    // Parts added to a request already on the list: told at the end of the turn.
    const later = items.filter(item => item.parent && list.some(one => one.id === parentOf(item.parent)))
    if (later.length > 0) {
      const now = await read($, intents)
      await note($, 'added', later.flatMap(item => now.filter(one => one.id === item.id)))
    }
    await save($)
    await refreshTitle($)

    return { result: listText(await read($, purpose), await read($, intents)) }
  })

  on('tool.call', { tool: 'mcp__intent-tracker__intent_list' }, async $ => {
    await sync($)

    return { result: listText(await read($, purpose), await read($, intents), true) }
  })

  on('tool.call', { tool: 'mcp__intent-tracker__intent_met' }, async ($, e) => {
    if (fromSubagent(e)) return { deny: SUBAGENT_DENY }
    await sync($)
    const args = e as unknown as Record<string, unknown>
    const list = await read($, intents)
    const id = resolveId(list, str(args.id)) ?? str(args.id)
    const evidence = str(args.evidence)
    const one = list.find(item => item.id === id)
    const p = await read($, purpose)
    if (!one) return { deny: `No item with id "${id}".\n${listText(p, list)}` }
    if (one.closed) return { deny: `Item ${id} is ${one.closed.as}; restore it first (intent_revise restore: true) if it applies again.` }
    if (kindOf(one) === 'limit') return { deny: `Item ${id} is a limit: it is never ticked. It holds, or intent_revise broken: "<evidence>".` }
    if (partsOf(list, id).length > 0) return { deny: `Request ${id} has parts: tick its parts; the request is done when all of them are.\n${listText(p, list)}` }
    if (!evidence) return { deny: 'evidence is required: name the check you ran and what it showed.' }
    const at = await $.clock.now()
    await update($, intents, l =>
      l.map(item =>
        item.id === id
          ? withHistory(
              { ...item, isMet: true, evidence, isAuto: false, isActive: false, isStale: false },
              entry(at, 'claude', item.isMet && item.isAuto ? 'confirmed' : 'met', evidence),
            )
          : item,
      ),
    )
    await save($)
    await refreshTitle($)

    return { result: listText(await read($, purpose), await read($, intents)) }
  })

  on('tool.call', { tool: 'mcp__intent-tracker__intent_revise' }, async ($, e) => {
    if (fromSubagent(e)) return { deny: SUBAGENT_DENY }
    await update($, pendingRecord, () => false)
    await sync($)
    const args = e as unknown as Record<string, unknown>
    const list = await read($, intents)
    const id = str(args.id) ? (resolveId(list, str(args.id)) ?? str(args.id)) : ''
    const newPurpose = str(args.purpose)
    const p = await read($, purpose)
    if (!id && !newPurpose) return { deny: `Give an item id, a purpose, or both.\n${listText(p, list)}` }
    const one = list.find(item => item.id === id)
    if (id && !one) return { deny: `No item with id "${id}".\n${listText(p, list)}` }
    const cancel = str(args.cancel)
    const broken = str(args.broken)
    if (one) {
      if (one.closed && (cancel || broken || args.reopen === true || args.holding === true)) {
        return { deny: `Item ${id} is ${one.closed.as}: restore it first (restore: true).` }
      }
      if (args.restore === true && !one.closed) return { deny: `Item ${id} is not closed.` }
      if ((broken || args.holding === true) && kindOf(one) !== 'limit') return { deny: `Item ${id} is a goal; broken and holding are for limits.` }
      if (args.reopen === true && kindOf(one) === 'limit') return { deny: `Item ${id} is a limit; use holding: true.` }
      const isPartOnly = args.active !== undefined || args.agent !== undefined || args.position !== undefined
      if (isPartOnly && (isRequest(one) || one.closed)) return { deny: 'active, agent and position are for live parts.' }
      if (cancel && isRequest(one) && !said(await heard($), cancel)) {
        return {
          deny: `A request is cancelled only on the person's word: they never said "${cancel}". Quote their words exactly; if they did not drop it, leave it.`,
        }
      }
    }

    const at = await $.clock.now()
    if (newPurpose) await update($, purpose, old => ({ ...old, ai: newPurpose }))
    if (one) {
      await update($, intents, l => {
        let next = l.map(item => {
          if (item.id !== id) return item
          let changed: Intent = { ...item }
          const summary = str(args.summary)
          const check = str(args.check)
          if (summary && summary !== item.ai) {
            changed = withHistory({ ...changed, ai: summary }, entry(at, 'claude', 'edited', `${item.ai} → ${summary}`))
          }
          if (check && check !== item.check) {
            changed = withHistory({ ...changed, check }, entry(at, 'claude', 'edited', `${item.check} → ${check}`))
          }
          if (args.reopen === true) {
            changed = withHistory({ ...changed, isMet: false, evidence: '', isAuto: false }, entry(at, 'claude', 'reopened'))
          }
          if (broken) changed = withHistory({ ...changed, broken: { evidence: broken, at } }, entry(at, 'claude', 'broken', broken))
          if (args.holding === true) {
            delete changed.broken
            changed = withHistory(changed, entry(at, 'claude', 'holding'))
          }
          if (typeof args.active === 'boolean') changed = { ...changed, isActive: args.active }
          if (typeof args.agent === 'string') {
            changed = { ...changed, isActive: true }
            if (str(args.agent)) changed.agent = str(args.agent)
            else delete changed.agent
          }
          // Edited or re-planned by Claude: no longer stale.
          if (summary || check || args.reopen === true || args.active === true) changed = { ...changed, isStale: false }
          if (args.confirm === true) {
            const wasAuto = changed.isAuto || changed.closed?.isAuto || changed.broken?.isAuto
            changed = { ...changed, isAuto: false }
            if (changed.closed) changed.closed = { ...changed.closed, isAuto: false }
            if (changed.broken) changed.broken = { ...changed.broken, isAuto: false }
            if (wasAuto) changed = withHistory(changed, entry(at, 'claude', 'confirmed'))
          }
          return changed
        })
        if (cancel && one && !one.closed) {
          const by: Actor = isRequest(one) ? 'person' : 'claude'
          next = close(next, id, { as: 'cancelled', reason: cancel, by, at })
        }
        if (args.restore === true) next = restore(next, id, at, 'claude')
        if (typeof args.position === 'number') next = movePart(next, id, args.position)
        return next
      })
      // A subagent named for this part: link any already running whose description matches.
      if (str(args.agent)) {
        const words = str(args.agent)
        const running = Object.entries(await read($, spawned)).filter(([, description]) => isAgentFor(description, words))
        if (running.length > 0) {
          await update($, agentLinks, links => ({ ...links, ...Object.fromEntries(running.map(([agentId]) => [agentId, id])) }))
          await update($, background, b => Object.fromEntries(Object.entries(b).filter(([k]) => !running.some(([agentId]) => k === `agent:${agentId}`))))
        }
      }
      if (args.active === false || cancel) await update($, activity, a => Object.fromEntries(Object.entries(a).filter(([k]) => k !== id)))
      // A part changed by Claude: told at the end of the turn (ticks and focus show for themselves).
      if (one.parent) {
        const what = cancel
          ? 'cancelled'
          : args.restore === true
            ? 'restored'
            : typeof args.position === 'number'
              ? 'moved'
              : str(args.summary) || str(args.check)
                ? 'edited'
                : null
        if (what) await note($, what, [one])
      }
    }
    await save($)
    await refreshTitle($)

    return { result: listText(await read($, purpose), await read($, intents)) }
  })

  // Every call moves the live activity (plan, investigate, build, test, fix,
  // review): a subagent's goes to the part it was sent for, the main loop's to
  // the active parts no subagent is on (and to the session's own stage line).
  // A finished test, build or report also reaches the model with the open
  // items beside it, and wakes the observer.
  on('tool.call', async ($, e, next) => {
    const call = e as unknown as Record<string, unknown>
    if (String(call.tool).startsWith(`mcp__${P}__`) || !(await read($, isActive))) return next(e)
    const command = typeof call.command === 'string' ? call.command : ''
    const isVerify = call.tool === 'Bash' && VERIFY_COMMAND.test(command)
    const isTest = isVerify && TEST_COMMAND.test(command)
    const agentId = (e as { agentId?: string }).agentId
    const before = await read($, stage)
    const step = isVerify && !isTest ? 'compile' : stageOf(call, isTest, agentId ? false : before.isTestFailing)
    // While the tool runs, its stage; once it returns, the model is thinking again.
    if (step) await setNow($, agentId, step)
    const done = await next(e)
    if (step) await setNow($, agentId, 'think')
    // A background task stopped by hand sends no completion notice: it leaves now.
    if ((call.tool === 'TaskStop' || call.tool === 'KillShell') && !('deny' in done)) {
      const stopped = str(call.task_id) || str(call.shell_id)
      if (stopped) await update($, background, b => without(without(b, `cmd:${stopped}`), `agent:${stopped}`))
    }
    // A command sent to the background keeps running after its call returns: shown until its notification.
    const taskId = !('deny' in done) && call.tool === 'Bash' ? (done.result as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId : undefined
    if (typeof taskId === 'string' && taskId) {
      const at = await $.clock.now()
      const label = shortLabel(typeof call.description === 'string' && call.description ? call.description : command)
      const kind: StageKey = isTest ? 'test' : isVerify ? 'compile' : 'run'
      await update($, background, b => ({ ...b, [`cmd:${taskId}`]: { label, stage: kind, at } }))
    }
    // Working before the person's message is on the list: remind once, beside this first result.
    const isPrep = ['AskUserQuestion', 'ToolSearch', 'TodoWrite', 'Skill'].includes(String(call.tool))
    const late = !agentId && !isPrep && (await read($, pendingRecord)) && !('deny' in done)
    if (late) await update($, pendingRecord, () => false)
    const withLate = (r: typeof done) => (late && !('deny' in r) ? { ...r, context: [...(r.context ?? []), RECORDED_LATE] } : r)
    if (agentId || !isResult(call) || 'deny' in done) return withLate(done)
    // A test run that failed turns the next edits into fixing; a passing one ends that.
    if (isTest && call.run_in_background !== true) await update($, stage, old => ({ ...old, isTestFailing: done.isError === true }))
    observeSoon($)
    await sync($)
    const reminder = resultNote(await read($, intents))
    if (!reminder) return withLate(done)

    return withLate({ ...done, context: [...(done.context ?? []), reminder] })
  })

  // A model request starting: that loop is thinking (until its next tool runs).
  on('turn.step', async function* ($, e, next) {
    if (await read($, isActive)) await setNow($, e.agentId, 'think')

    return yield* next(e)
  })

  // A subagent sent for a part: link it, so its activity shows on that part.
  on('agent.spawn', async ($, e, next) => {
    const done = await next(e)
    const agentId = done.agentId
    if (!agentId || !(await read($, isActive))) return done
    await update($, spawned, m => ({ ...m, [agentId]: e.description }))
    const part = (await read($, intents)).find(one => one.parent && isLive(one) && one.agent && isAgentFor(e.description, one.agent))
    if (part) await update($, agentLinks, l => ({ ...l, [agentId]: part.id }))
    else {
      // Not sent for a part: shown on its own while it runs.
      const at = await $.clock.now()
      const first = stageOf({ tool: 'Agent', subagent_type: e.subagentType, description: e.description }, false, false) ?? 'think'
      await update($, background, b => ({ ...b, [`agent:${agentId}`]: { label: shortLabel(e.description), stage: first, at } }))
    }

    return done
  })

  // After each main-loop turn: one notice for Claude's changes to parts, and
  // the observer reads the turn. A subagent's end clears its part's activity.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!(await read($, isActive))) return done
    if (e.agentId) {
      const agentId = e.agentId
      const partId = (await read($, agentLinks))[agentId]
      await update($, background, b => without(b, `agent:${agentId}`))
      await update($, agentLinks, l => without(l, agentId))
      await update($, spawned, m => without(m, agentId))
      if (partId && !Object.values(await read($, agentLinks)).includes(partId)) await update($, activity, a => without(a, partId))
      return done
    }
    // The turn is over: nothing is happening now, except what running subagents do.
    const working = new Set(Object.values(await read($, agentLinks)))
    await update($, activity, a => Object.fromEntries(Object.entries(a).filter(([k]) => working.has(k))))
    await update($, stage, old => ({ ...old, now: null }))
    const told = await read($, notes)
    if (told.length > 0) {
      await update($, notes, () => [])
      $.ui.toast(strings(await read($, lang)).toastTurn(told))
    }
    if (e.reason === 'answer') {
      $.clock.after(0, () => {
        void checkTurn($, e.durationMs).catch(() => undefined)
      })
    }

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const table = $.ui.resolve(e)
    // The terminal draws a line of box characters sized to the pane's columns;
    // a desktop (proportional font) wraps such a line, so it gets a 1px rule.
    const rule =
      e.surface === 'terminal' || !('Svg' in table) ? (
        <Text dimColor>{'─'.repeat(Math.max(8, Math.min(e.props.bodyColumns ?? 40, 60)))}</Text>
      ) : (
        <table.Svg key="rule" source={RULE_SVG} alt="" height={1} />
      )
    const list = await read($, intents)
    const p = await read($, purpose)
    const off = await read($, drift)
    const edit = await read($, editing)
    const lastAt = await read($, updatedAt)
    const nowMs = await read($, now)
    const chosen = await read($, lang)
    const isDoneShown = await read($, isDoneOpen)
    const checker = await read($, driftModel)
    const t = strings(chosen)
    const mainModel = modelName(await $.session.model().catch(() => t.mainSession))
    const columns = e.props.bodyColumns ?? 40
    const details = await read($, shownDetails)
    const where = await read($, stage)
    const live = list.filter(isLive)
    // Goal requests (and any part left without its request) lead; limits sit apart.
    const requests = live.filter(one => kindOf(one) === 'goal' && (isRequest(one) || !live.some(r => r.id === one.parent)))
    const openRequests = requests.filter(one => !isDone(list, one))
    const doneRequests = requests.filter(one => isDone(list, one))
    const limits = live.filter(one => isRequest(one) && kindOf(one) === 'limit')
    const counted = progress(list)
    const autoCount = units(list).filter(one => one.isMet && one.isAuto).length
    const quote = (text: string) => (chosen.code === 'zh' || chosen.code === 'ja' ? `「${text}」` : `"${text}"`)

    const choose = async (next: Lang) => {
      await update($, lang, () => next)
      await update($, editing, () => null)
      await $.store.set(LANG_KEY, next)
      await refreshTitle($)
    }

    const chooseModel = async (next: string) => {
      await update($, driftModel, () => next)
      await update($, editing, () => null)
      await $.store.set(DRIFT_MODEL_KEY, next)
    }

    const saveMine = (target: string) => (value: string) => {
      void (async () => {
        const text = value.trim()
        await sync($)
        const at = await $.clock.now()
        if (target === 'purpose') await update($, purpose, old => ({ ...old, mine: text }))
        else {
          await update($, intents, l =>
            l.map(one =>
              one.id === target && one.mine !== text ? withHistory({ ...one, mine: text }, entry(at, 'person', 'edited', text)) : one,
            ),
          )
        }
        await update($, editing, () => null)
        await update($, isDirty, () => true)
        await save($)
      })()
    }

    /** A small ✎ that opens the field for the person's own words. */
    const pencil = (target: string) => (
      <Button key={`edit-${target}`} label="✎" plain dimColor onPress={() => update($, editing, () => target)} />
    )

    /** The field for the person's own words, shown only while they write. */
    const mineField = (target: string, mine: string) => (
      <Input
        key={`mine-${target}`}
        label={`${t.you}${t.colon}`}
        placeholder={t.minePlaceholder}
        value={mine}
        submitLabel={t.save}
        autoFocus
        onSubmit={saveMine(target)}
      />
    )

    // Bottom toolbar: light, chrome-free buttons; icon + text where the pane is
    // wide enough for every label, icon alone where it is not.
    type Tool = { key: string; icon: string; text: string; onPress: () => unknown }
    const toolbar = (tools: readonly Tool[]) => {
      const full = tools.reduce((sum, one) => sum + cells(`${one.icon} ${one.text}`), 0) + TOOLBAR_GAP * (tools.length - 1)
      const isWide = columns >= full
      return (
        <Box flexDirection="row" gap={TOOLBAR_GAP}>
          {tools.map(one => (
            <Button key={one.key} label={isWide ? `${one.icon} ${one.text}` : one.icon} plain dimColor onPress={one.onPress} />
          ))}
        </Box>
      )
    }

    const startTool: Tool = {
      key: 'start',
      icon: '▶',
      text: t.start,
      onPress: async () => {
        await $.prompt.submit({ text: t.startPrompt(TOOLS, langName(chosen)) })
        $.ui.toast(t.toastStart)
      },
    }
    const refreshTool: Tool = {
      key: 'refresh-ai',
      icon: '↻',
      text: t.refresh,
      onPress: async () => {
        // A turn of its own once the session is idle; the model may change
        // only the AI side (purpose, summaries, checks, ticks).
        await $.prompt.submit({ text: t.refreshPrompt(TOOLS, langName(chosen)) })
        $.ui.toast(t.toastRefresh)
      },
    }
    const clearTool: Tool = {
      key: 'clear',
      icon: '⌫',
      text: t.clear,
      onPress: () => update($, editing, () => 'confirm-clear'),
    }
    // A close at the bottom too: a host's own header may cover the pane's close mark.
    const closeTool: Tool = {
      key: 'close',
      icon: '✕',
      text: t.close,
      onPress: async () => {
        // The mod's own close skips its own ui.close hook, so mark it here.
        await update($, isClosedByPerson, () => true)
        await $.ui.close({ id: PANE })
      },
    }

    // Metadata on one light line below a divider; 🌐 opens the language choices.
    const isPicking = edit === 'lang' || edit === 'lang-custom'
    // The drift model's name opens the model choices, as 🌐 opens the languages.
    const isPickingModel = edit === 'model'
    const meta = [
      ...(lastAt === null ? [] : [ago(t, lastAt, Math.max(nowMs, lastAt))]),
      `${t.mainShort} ${mainModel}`,
      `${t.driftShort} `,
    ].join(' · ')
    const footer = (
      <Box flexDirection="column">
        {rule}
        <Box flexDirection="row" flexWrap="wrap">
          <Text dimColor wrap="wrap">{meta}</Text>
          <Button
            key="drift-model"
            label={modelName(checker)}
            plain
            dimColor
            onPress={() => update($, editing, () => (isPickingModel ? null : 'model'))}
          />
          <Text dimColor>{' · '}</Text>
          <Button
            key="lang"
            label={`🌐 ${langLabel(chosen)}`}
            plain
            dimColor
            onPress={() => update($, editing, () => (isPicking ? null : 'lang'))}
          />
        </Box>
        {isPickingModel && (
          <Box flexDirection="row" gap={TOOLBAR_GAP} flexWrap="wrap">
            {DRIFT_MODELS.map(id => (
              <Button
                key={`model-${id}`}
                label={modelName(id)}
                plain
                dimColor={checker !== id}
                onPress={() => chooseModel(id)}
              />
            ))}
          </Box>
        )}
        {isPicking && (
          <Box flexDirection="row" gap={TOOLBAR_GAP} flexWrap="wrap">
            {(
              [
                { key: 'lang-en', label: 'English', lang: { code: 'en' } },
                { key: 'lang-zh', label: '中文', lang: { code: 'zh' } },
                { key: 'lang-ja', label: '日本語', lang: { code: 'ja' } },
              ] as const
            ).map(o => (
              <Button key={o.key} label={o.label} plain dimColor={chosen.code !== o.lang.code} onPress={() => choose(o.lang)} />
            ))}
            <Button
              key="lang-custom"
              label={chosen.code === 'custom' ? `${t.customOption} ${langLabel(chosen)}` : t.customOption}
              plain
              dimColor={chosen.code !== 'custom'}
              onPress={() => update($, editing, () => 'lang-custom')}
            />
          </Box>
        )}
        {edit === 'lang-custom' && (
          <Input
            key="lang-custom-input"
            placeholder={t.customPlaceholder}
            value={chosen.code === 'custom' ? (chosen.custom ?? '') : ''}
            submitLabel={t.save}
            autoFocus
            onSubmit={value => {
              const text = value.trim()
              void (text ? choose({ code: 'custom', custom: text }) : update($, editing, () => null))
            }}
          />
        )}
      </Box>
    )

    /** A change the person makes in the pane: read the shared copy, change, save, tell Claude next prompt. */
    const personDo = (change: (l: Intent[], at: number) => Intent[]) => async () => {
      await sync($)
      const at = await $.clock.now()
      await update($, intents, l => change(l, at))
      await update($, editing, () => null)
      await update($, isDirty, () => true)
      await save($)
      await refreshTitle($)
    }

    if (list.length === 0 && !p.ai) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>{t.empty}</Text>
          {toolbar([startTool, closeTool])}
          {footer}
        </Box>
      )
    }

    // The purpose: one line. The person's words lead when they wrote some,
    // Claude's line under them, light.
    const purposeBlock = (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold wrap="wrap">
            {p.mine || p.ai || t.notYet}
          </Text>
          {edit !== 'purpose' && pencil('purpose')}
        </Box>
        {p.mine && p.ai && p.mine !== p.ai && (
          <Text dimColor wrap="wrap">
            {t.ai}
            {t.colon}
            {p.ai}
          </Text>
        )}
        {edit === 'purpose' && mineField('purpose', p.mine)}
      </Box>
    )

    // Progress at a glance (the count is in the title too): parts count, a
    // request with no parts counts as one. The bar fills the pane's width: the
    // terminal in block characters, the desktop (whose font would wrap them)
    // as a drawn bar.
    const share = counted.total === 0 ? 0 : counted.met / counted.total
    const countLabel = `${counted.met}/${counted.total}`
    const barWidth = Math.max(6, columns - cells(` ${countLabel}`))
    const filled = Math.round(share * barWidth)
    const progressBar =
      e.surface === 'terminal' || !('Svg' in table) ? (
        <Text dimColor>
          {'▓'.repeat(filled)}
          {'░'.repeat(barWidth - filled)} {countLabel}
        </Text>
      ) : (
        <Box flexDirection="row" gap={1} alignItems="center">
          <Box flexGrow={1}>
            <table.Svg key="progress" source={progressSvg(share)} alt={countLabel} height={6} />
          </Box>
          <Text dimColor>{countLabel}</Text>
        </Box>
      )

    // What is happening now, the latest only: beside each active part, its own
    // activity; with no part showing one, the session's stage under the bar.
    const live$ = await read($, activity)
    const isActivityShown = live.some(one => one.parent && one.isActive && !one.isMet && live$[one.id])
    const stageLine = !isActivityShown && where.now && (
      <Text bold color="cyan">
        {t.nowLabel}
        {t.colon}
        {t.stage[where.now]}
      </Text>
    )
    // Still running beside the main loop (background commands, subagents not sent for a part).
    const running = Object.entries(await read($, background))
    const backgroundBlock = running.length > 0 && (
      <Box flexDirection="column">
        <Text dimColor>{t.alongside}</Text>
        {running.map(([key, item]) => (
          <Box key={`bg-${key}`}>
            <Text color="cyan" wrap="wrap">
              {'  '}
              {key.startsWith('agent:') ? t.subagent : t.backgroundCommand}
              {chosen.code === 'zh' || chosen.code === 'ja' ? `「${item.label}」` : ` "${item.label}"`}
              {t.colon}
              {t.stage[item.stage]}
              {(() => {
                // A command quiet for a while says so: it may be waiting, or stuck.
                const quiet = item.lastOutputAt ? Math.floor((nowMs - item.lastOutputAt) / 60_000) : 0
                return quiet >= 2 ? t.paren(t.quietFor(quiet)) : ''
              })()}
            </Text>
          </Box>
        ))}
      </Box>
    )

    const driftBox = off && (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text color="yellow" wrap="wrap">
          ⚠️ {t.drift}
          {off.isByUser ? t.byUser : ''}
          {t.colon}
          {off.note}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button
            key="drift-add"
            label={t.addToList}
            onPress={async () => {
              await personDo((l, at) => [
                ...l,
                {
                  id: String(nextId(l)),
                  ai: off.note,
                  mine: '',
                  check: '',
                  isMet: false,
                  evidence: '',
                  kind: 'goal',
                  source: '',
                  history: [entry(at, 'person', 'added', t.addedInPane)],
                },
              ])()
              await update($, drift, () => null)
              await save($)
            }}
          />
          <Button
            key="drift-ignore"
            label={t.ignore}
            onPress={async () => {
              await sync($)
              await update($, drift, () => null)
              await save($)
            }}
          />
        </Box>
      </Box>
    )

    /** ✎ (the person's words), ✕ (cancel) and ⋯ (where it came from, its evidence). */
    const itemTools = (one: Intent) => (
      <Box flexDirection="row" gap={1}>
        {edit !== one.id && pencil(one.id)}
        <Button key={`cancel-${one.id}`} label="✕" plain dimColor onPress={() => update($, editing, () => `cancel-${one.id}`)} />
        <Button
          key={`details-${one.id}`}
          label={details === one.id ? '▾' : '⋯'}
          plain
          dimColor
          onPress={() => update($, shownDetails, v => (v === one.id ? null : one.id))}
        />
      </Box>
    )

    const cancelRow = (one: Intent) =>
      edit === `cancel-${one.id}` && (
        <Box flexDirection="row" gap={1}>
          <Text color="red">{t.confirmCancelItem}</Text>
          <Button
            key={`cancel-yes-${one.id}`}
            label={t.cancelYes}
            onPress={personDo((l, at) => close(l, one.id, { as: 'cancelled', reason: t.cancelledInPane, by: 'person', at }))}
          />
          <Button key={`cancel-no-${one.id}`} label={t.keep} onPress={() => update($, editing, () => null)} />
        </Box>
      )

    /** ⋯: the words that asked for it and the evidence; the latest only, no history. */
    const detailsBlock = (one: Intent, indent: string) =>
      details === one.id && (
        <Box flexDirection="column">
          {one.source && (
            <Text dimColor wrap="wrap">
              {indent}
              {'  '}
              {t.saidLabel}
              {t.colon}
              {quote(one.source)}
            </Text>
          )}
          {one.isMet && one.evidence && (
            <Text dimColor wrap="wrap">
              {indent}
              {'  '}
              {t.evidence}
              {t.colon}
              {one.evidence}
            </Text>
          )}
        </Box>
      )

    /**
     * An open goal request with its parts under it, or a part: ✓ done, ● being
     * worked on (with what is happening now), ○ later; a part the work may
     * have overtaken says so.
     */
    const goalRow = (one: Intent, indent: string): JSX.Element => {
      const parts = partsOf(list, one.id)
      const metParts = parts.filter(part => part.isMet).length
      // A request with parts is done when they all are, whatever it was ticked before (a follow-up reopens it).
      const isFinished = parts.length > 0 ? parts.every(part => part.isMet) : one.isMet
      const isWorking = !!one.parent && !one.isMet && one.isActive === true
      const mark = isFinished ? '✓' : isWorking ? '●' : metParts > 0 ? '◐' : '○'
      const now$ = isWorking ? live$[one.id] : undefined
      const tags = [
        one.isMet && one.isAuto ? t.seenInOutput : '',
        !one.isMet && one.isAuto ? t.autoMark : '',
        one.isStale && !one.isMet ? t.staleLabel : '',
      ].filter(Boolean)
      return (
        <Box key={`goal-${one.id}`} flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text
              bold={!one.parent && !isFinished}
              color={isFinished ? 'green' : isWorking ? 'cyan' : one.isStale || one.isAuto ? 'yellow' : undefined}
              wrap="wrap"
            >
              {indent}
              {mark} {labelOf(list, one)}. {one.ai}
              {parts.length > 0 ? ` ${metParts}/${parts.length}` : ''}
              {tags.length > 0 ? t.paren(tags.join(' · ')) : ''}
              {now$ ? `  ${t.nowLabel}${t.colon}${t.stage[now$]}` : ''}
            </Text>
            {itemTools(one)}
          </Box>
          {one.mine && edit !== one.id && (
            <Text wrap="wrap">
              {indent}
              {'  '}
              {t.you}
              {t.colon}
              {one.mine}
            </Text>
          )}
          {edit === one.id && mineField(one.id, one.mine)}
          {!one.isMet && parts.length === 0 && (
            <Text dimColor wrap="wrap">
              {indent}
              {'  '}
              {t.check}
              {t.colon}
              {one.check || t.noCheck}
            </Text>
          )}
          {cancelRow(one)}
          {detailsBlock(one, indent)}
          {parts.map(part => goalRow(part, `${indent}  `))}
        </Box>
      )
    }

    const limitsBlock = limits.length > 0 && (
      <Box flexDirection="column">
        <Text dimColor>{t.limits}</Text>
        {limits.map(one => (
          <Box key={`limit-${one.id}`} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={one.broken ? 'red' : one.isAuto ? 'yellow' : undefined} wrap="wrap">
                {one.broken ? '✗' : '🛡'} {one.id}. {one.ai}
                {one.broken?.isAuto || one.isAuto ? t.paren(t.autoMark) : ''}
              </Text>
              {itemTools(one)}
            </Box>
            {one.mine && edit !== one.id && (
              <Text wrap="wrap">
                {'  '}
                {t.you}
                {t.colon}
                {one.mine}
              </Text>
            )}
            {edit === one.id && mineField(one.id, one.mine)}
            {one.broken ? (
              <Text color="red" wrap="wrap">
                {'  '}
                {t.brokenLabel}
                {t.colon}
                {one.broken.evidence}
              </Text>
            ) : (
              <Text dimColor wrap="wrap">
                {'  '}
                {t.holding} · {t.check}
                {t.colon}
                {one.check || t.noCheck}
              </Text>
            )}
            {cancelRow(one)}
            {detailsBlock(one, '')}
          </Box>
        ))}
      </Box>
    )

    // What is done, folded to one line; open it for each request, its parts and the evidence.
    const doneGroup = doneRequests.length > 0 && (
      <Box flexDirection="column">
        <Button
          key="done-toggle"
          label={`✓ ${t.doneGroup(doneRequests.length)}${autoCount > 0 ? t.paren(t.autoCount(autoCount)) : ''} ${isDoneShown ? '▾' : '▸'}`}
          plain
          dimColor
          onPress={() => update($, isDoneOpen, v => !v)}
        />
        {isDoneShown &&
          doneRequests.map(one => {
            const parts = partsOf(list, one.id)
            const isSeen = one.isAuto === true && parts.length === 0
            return (
              <Box key={`done-${one.id}`} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text color="green" wrap="wrap">
                    ✓ {one.id}. {one.mine || one.ai}
                    {isSeen ? t.paren(t.seenInOutput) : ''}
                  </Text>
                  <Button
                    key={`details-${one.id}`}
                    label={details === one.id ? '▾' : '⋯'}
                    plain
                    dimColor
                    onPress={() => update($, shownDetails, v => (v === one.id ? null : one.id))}
                  />
                </Box>
                {parts.map(part => (
                  <Box key={`done-part-${part.id}`}>
                    <Text dimColor wrap="wrap">
                      {'  '}✓ {labelOf(list, part)}. {part.mine || part.ai}
                      {part.isAuto ? t.paren(t.seenInOutput) : ''}
                    </Text>
                  </Box>
                ))}
                {details === one.id && detailsBlock(one, '')}
              </Box>
            )
          })}
      </Box>
    )

    const clearRow =
      edit === 'confirm-clear' ? (
        <Box flexDirection="row" gap={1}>
          <Text color="red">{t.confirmClear}</Text>
          <Button
            key="clear-yes"
            label={t.clearYes}
            onPress={async () => {
              await update($, purpose, () => ({ ai: '', mine: '' }))
              await update($, intents, () => [])
              await update($, drift, () => null)
              await update($, editing, () => null)
              await update($, isDirty, () => false)
              await save($)
              await refreshTitle($)
            }}
          />
          <Button key="clear-no" label={t.cancel} onPress={() => update($, editing, () => null)} />
        </Box>
      ) : (
        toolbar([refreshTool, clearTool, closeTool])
      )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {purposeBlock}
          {counted.total > 0 && progressBar}
          {stageLine}
          {backgroundBlock}
        </Box>
        {driftBox}
        {openRequests.map(one => goalRow(one, ''))}
        {limitsBlock}
        {doneGroup}
        {clearRow}
        {footer}
      </Box>
    )
  })
}
