import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Actor, Drift, Intent, Purpose, Stage } from '../types'
import { ago, asLang, DEFAULT_LANG, langLabel, langName, strings } from './i18n'
import type { Lang } from './i18n'
import {
  close,
  currentPhase,
  entry,
  findPhase,
  isDone,
  isLive,
  isPhaseDone,
  isRequest,
  kindOf,
  listText,
  livePhases,
  nextId,
  nextPhaseNumber,
  normalize,
  partsOf,
  personTexts,
  phaseParts,
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
/** What the person typed in this session: prompts, mid-turn messages, dialog answers (the last 50). */
const heardSaid = atom({ plugin: 'intent-tracker', key: 'heardSaid' } as const, [] as { text: string; at: number }[])
const HEARD_MAX = 50

async function remember($: EngineInterface, texts: readonly string[]): Promise<void> {
  const kept = texts.map(text => text.trim()).filter(Boolean)
  if (kept.length === 0) return
  const at = await $.clock.now()
  await update($, heardSaid, old => [...old, ...kept.map(text => ({ text, at }))].slice(-HEARD_MAX))
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
  phase: TOOL('intent_phase'),
}

type Saved = { purpose: Purpose; intents: Intent[]; drift: Drift | null; updatedAt?: number }

const instructions = (language: string) => `# Intent pane (intent-tracker mod)
A pane beside the chat shows the person, in plain ${language}, what they asked for in this worktree and how far it has got, so they do not get lost when the conversation turns technical. The list is kept per worktree across sessions. Keep it accurate and quiet (do not narrate these calls).
What the list holds, in two layers:
- REQUESTS: only what the person asked for, never your own ideas or technical tasks. A goal is an outcome they want; a limit is something they said must not happen or must stay as it is ("don't touch sync"); a limit is never ticked, it holds or is broken. Each request carries \`source\`: the person's own words that asked for it, quoted exactly from their message (or their pane text); the tool refuses words the person never said. Work you suggest joins only once they say yes; then quote their yes.
- PARTS: break each goal request into the parts the person would recognise as pieces of what they asked: plain outcomes they can follow ("drafts survive closing the app", "sync still works"), never technical steps ("edit NoteStore.swift", "add a test"). Add them with \`parent\`: the request's id. A single request usually has several parts; progress counts parts, and a request is done when all its parts are. Revise the breakdown as you learn more (add parts, cancel ones that no longer apply).
- PHASES: when a request's work runs in stages, plan them as ordered phases in plain words ("agree the approach", "build it", "check nothing old broke") with \`phases\` on the request (or ${TOOL('intent_phase')}), and put each part in its phase with \`phase\` (the phase's id, or its position: "2"). The current phase is the first one not done; a phase with parts is done when they all are, one without parts when you mark it done with ${TOOL('intent_phase')}. Add, rename, reorder or cancel phases as the plan changes; move a part with ${TOOL('intent_revise')} phase. Parts and phases are yours to change without asking: the person is told by a notice.
Adding: when the person states the task or adds to it, call ${TOOL('intent_add')} with a one-line \`purpose\` and the items. \`summary\`: one plain ${language} sentence a non-programmer understands (no file names, SHAs, flags or jargon); \`check\`: the concrete step that proves it (for a limit: how to see it still holds), identifiers allowed. Everything in ${language}. Never re-add an item already listed.
Ticking: ${TOOL('intent_met')} only after a goal's (or part's) check actually ran and passed, with the evidence; never on intent, partial work or an unrun check. If later work breaks a met one, ${TOOL('intent_revise')} reopen: true. A limit a result shows broken: ${TOOL('intent_revise')} broken: "<evidence>"; once it holds again, holding: true.
Changes of mind: when the person drops a request, ${TOOL('intent_revise')} cancel: "<their words>" (its parts close with it). When they change what they want, add the new request with \`replaces\`: "<old id>" and the new source; the old one stays on record as replaced, and a changed goal is verified afresh. A wording-only tweak: ${TOOL('intent_revise')} summary/check.
Keep the pane live: results that run a check (a test or build, a subagent's report, a background task's notification) carry an <intent-pane> note; act on it in the same step, before you reply or move on; ignore it when it does not apply.
After a turn, a small model may tick a goal, mark a limit broken, or record a request, a drop or a change of mind you missed; those show as "(auto, unconfirmed)". When you next see one, confirm it (${TOOL('intent_met')} for a tick, ${TOOL('intent_revise')} confirm: true otherwise) or undo it (reopen, restore: true, holding: true).
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
                  "A request (no parent): the person's own words that asked for it, quoted exactly from their message. Not needed for a part.",
              },
              parent: { type: 'string', description: "A part: the id of the goal request it is a piece of." },
              replaces: {
                type: 'string',
                description: 'A request that replaces an earlier one because the person changed what they want: that id.',
              },
              phases: {
                type: 'array',
                items: { type: 'string' },
                description: 'A goal request: its planned phases in order, plain titles.',
              },
              phase: {
                type: 'string',
                description: "A part: its request's phase, by id (\"P2\") or position (\"2\").",
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
        id: { type: 'string', description: 'The goal id shown in the list ("1", "2", ...).' },
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
        id: { type: 'string', description: 'The item to change; omit when changing only the purpose.' },
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
        phase: { type: 'string', description: 'A part: move it to this phase of its request (id or position); "" for none.' },
      },
    },
    isDeferred: false,
  },
  {
    name: 'intent_phase',
    description:
      "Plan a goal request's phases, the ordered stages its parts fall in: add phases, rename one, move it, mark a part-less one done (or not), cancel one (its parts close with it: move parts that still apply first), or restore one. The person is told by a notice.",
    inputSchema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'The goal request id.' },
        add: { type: 'array', items: { type: 'string' }, description: 'New phase titles, appended in order (or inserted at position).' },
        id: { type: 'string', description: 'The phase to change: its id ("P2") or position ("2").' },
        title: { type: 'string', description: 'Rename it.' },
        position: { type: 'number', description: 'Move it (or insert the added ones) to this 1-based position.' },
        done: { type: 'boolean', description: 'A phase without parts: done or not.' },
        cancel: { type: 'string', description: 'Why it no longer applies.' },
        restore: { type: 'boolean', description: 'Bring a cancelled phase back, with its parts.' },
      },
      required: ['request'],
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
  const open = units(list).filter(one => !one.isMet || one.isAuto)
  const limits = list.filter(one => isLive(one) && kindOf(one) === 'limit')
  if (open.length === 0 && limits.length === 0) return null
  const lines = ['<intent-pane>A result just arrived. If it runs one of these checks, update the pane now, before going on:']
  for (const one of open) {
    lines.push(`${one.id}. [${one.isMet ? 'met (auto, unconfirmed)' : 'open'}] ${one.mine || one.ai} | check: ${one.check || '(none)'}`)
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

type Quoted = { id: string; quote: string; summary: string; check: string; evidence: string; kind: 'goal' | 'limit' }

type Verdict = {
  isOnTrack: boolean
  note: string
  isByUser: boolean
  met: Quoted[]
  broken: Quoted[]
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
          evidence: str(m.evidence),
          kind: m.kind === 'limit' ? ('limit' as const) : ('goal' as const),
        }))
    return {
      isOnTrack: value.onTrack !== false,
      note: str(value.note),
      isByUser: value.byUser === true,
      met: rows('met').filter(m => m.id && m.evidence),
      broken: rows('broken').filter(m => m.id && m.evidence),
      cancel: rows('cancel').filter(m => m.id && m.quote),
      replace: rows('replace').filter(m => m.id && m.quote && m.summary),
      add: rows('add').filter(m => m.quote && m.summary),
    }
  } catch {
    return null
  }
}

/** How much of each tool's output, and of all of them, the end-of-turn check reads. */
const OUTPUT_EACH = 1200
const OUTPUT_ALL = 14000

/**
 * After a turn: a small model reads the turn against the list and catches
 * what the main conversation missed. It flags off-list work (drift); ticks
 * goals the turn's tool output shows passing and marks limits it shows
 * broken; and, from the person's latest message, records a request, a drop or
 * a change of mind. Everything it applies is marked auto until the main
 * conversation confirms it; every quote it gives is checked against the
 * person's message.
 */
async function checkTurn($: EngineInterface, durationMs = 0): Promise<void> {
  const list = await read($, intents)
  const p = await read($, purpose)

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
  const midTurn = (await read($, heardSaid)).filter(one => one.at >= turnStart && one.text !== asked.text.trim()).map(one => one.text)
  const personWords = [...personTexts([asked], []), ...midTurn]

  const ask = [asked.text, ...midTurn].join('\n').slice(0, 2000)
  const work: string[] = []
  const outputs: string[] = []
  let outputLength = 0
  // Claude changed the list itself this turn: it read the person's message, so
  // requests, drops and changes are left to it (no second copy in other words).
  let isListedByClaude = false
  for (const m of messages.slice(start + 1)) {
    if (m.role !== 'assistant') continue
    if (m.text.trim()) work.push(`said: ${m.text.trim().slice(0, 600)}`)
    for (const use of m.toolUses) {
      if (use.tool === TOOLS.add || use.tool === TOOLS.revise) isListedByClaude = true
      if (use.tool.startsWith(`mcp__${P}__`)) continue
      work.push(`${use.tool}: ${JSON.stringify(use.input).slice(0, 300)}`)
      const out = (use.text ?? '').trim()
      if (!out || outputLength >= OUTPUT_ALL) continue
      // The tail of a long output is where a test run's summary is.
      const kept = out.length > OUTPUT_EACH ? `…${out.slice(-OUTPUT_EACH)}` : out
      const entry = `--- ${use.tool} ${JSON.stringify(use.input).slice(0, 160)}${use.isError ? ' (error)' : ''}\n${kept}`
      outputs.push(entry)
      outputLength += entry.length
    }
  }
  if (work.length === 0 && personWords.length === 0) return
  if (list.length === 0 && personWords.length === 0) return

  const language = langName(await read($, lang))
  const answer = await $.model.complete({
    model: await read($, driftModel),
    maxTokens: 700,
    system:
      "You check an AI coding assistant's latest turn against the list of what a person asked for. Reply with JSON only.",
    prompt:
      `${list.length > 0 ? listText(p, list) : 'The list is empty.'}\n\n` +
      `The person's latest message${personWords.length === 0 ? ' (an automatic notification, not the person)' : ''}:\n${ask}\n\n` +
      `What the assistant did this turn:\n${work.join('\n').slice(0, 8000) || '(nothing)'}\n\n` +
      (outputs.length > 0 ? `What the tools returned this turn (tails of long outputs):\n${outputs.join('\n')}\n\n` : '') +
      'The list holds only what the person asked for: requests (a goal, or a limit: something that must not happen), and parts (pieces of a goal request). Answer each question; when unsure, leave it out.\n' +
      '1. drift: work clearly unrelated to every item and to the purpose, that the person did not ask for. Investigation, setup, verification and fixing what blocks an item are on track.\n' +
      "2. met: open goals or parts (not limits, not requests that have parts) whose check a tool output above actually ran and showed passing: a passing test summary, a successful build line, a report stating the check passed. Never on a plan, the assistant's claim, a partial run, or an output with failures.\n" +
      '3. broken: live limits a tool output shows broken.\n' +
      "4. From the person's latest message only (skip if it is a notification), and only what the list does not already show:\n" +
      '   add: something they asked for that is no item yet: an outcome they want or a limit they set. Not a question, not thanks, not approval of a step already listed.\n' +
      '   cancel: a request they dropped ("never mind X", "skip X").\n' +
      '   replace: a request they changed into something else ("instead of X, do Y").\n' +
      "   Each needs \"quote\": their exact words from that message.\n" +
      'Reply with one JSON object, empty lists where nothing applies: {"onTrack": true|false, ' +
      `"note": "<when off track: one short plain sentence in ${language} naming the off-list work, no jargon>", ` +
      `"met": [{"id": "<id>", "evidence": "<one short line in ${language} naming the output that shows the pass, quoting its key line>"}], ` +
      `"broken": [{"id": "<limit id>", "evidence": "<one short line in ${language}>"}], ` +
      `"add": [{"quote": "<their exact words>", "kind": "goal"|"limit", "summary": "<one plain sentence in ${language}, no jargon>", "check": "<how to prove it, in ${language}>"}], ` +
      '"cancel": [{"id": "<request id>", "quote": "<their exact words>"}], ' +
      `"replace": [{"id": "<request id>", "quote": "<their exact words>", "summary": "<the new request, plain ${language}>", "check": "<how to prove it>"}]}`,
  })
  if (!answer.isAnswered) return

  const verdict = parseVerdict(answer.text)
  if (!verdict) return
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
  const byId = (id: string) => current.find(one => one.id === id)
  const isHeard = (quote: string) => !isListedByClaude && said(personWords, quote)
  const open = new Set(units(current).filter(one => !one.isMet).map(one => one.id))
  const ticks = verdict.met.filter(m => open.has(m.id))
  const breaks = verdict.broken.filter(m => {
    const one = byId(m.id)
    return one && isLive(one) && kindOf(one) === 'limit' && !one.broken
  })
  const cancels = verdict.cancel.filter(m => {
    const one = byId(m.id)
    return one && isLive(one) && isRequest(one) && isHeard(m.quote)
  })
  const replaces = verdict.replace.filter(m => {
    const one = byId(m.id)
    return one && isLive(one) && isRequest(one) && isHeard(m.quote) && !cancels.some(c => c.id === m.id)
  })
  // A request already on the list (by its source or its words) is not added twice.
  const known = current.filter(one => isRequest(one)).flatMap(one => [one.source ?? '', one.ai, one.mine].map(normalize))
  const adds = verdict.add.filter(m => {
    const quote = normalize(m.quote)
    return isHeard(m.quote) && !known.some(k => k && (k.includes(quote) || quote.includes(k)))
  })

  if (ticks.length + breaks.length + cancels.length + replaces.length + adds.length > 0) {
    await update($, intents, l => {
      let next = l.map(one => {
        const tick = ticks.find(m => m.id === one.id)
        if (tick) return withHistory({ ...one, isMet: true, evidence: tick.evidence, isAuto: true }, entry(at, 'auto', 'met', tick.evidence))
        const brk = breaks.find(m => m.id === one.id)
        if (brk) return withHistory({ ...one, broken: { evidence: brk.evidence, at, isAuto: true } }, entry(at, 'auto', 'broken', brk.evidence))
        return one
      })
      for (const c of cancels) next = close(next, c.id, { as: 'cancelled', reason: c.quote, by: 'person', at, isAuto: true })
      let n = nextId(next)
      const fresh = (m: Quoted): Intent => ({
        id: String(n++),
        ai: m.summary,
        mine: '',
        check: m.check,
        isMet: false,
        evidence: '',
        isAuto: true,
        kind: m.kind,
        source: m.quote,
        history: [entry(at, 'auto', 'added', m.quote)],
      })
      for (const r of replaces) {
        const added = fresh(r)
        next = close([...next, added], r.id, { as: 'replaced', reason: r.quote, by: 'person', at, replacedBy: added.id, isAuto: true })
      }
      for (const a of adds) next = [...next, fresh(a)]
      return next
    })
    if (ticks.length > 0) done.push(t.autoTicked(ticks.map(m => m.id)))
    if (breaks.length > 0) done.push(t.autoBroken(breaks.map(m => m.id)))
    if (cancels.length > 0) done.push(t.autoCancelled(cancels.map(m => m.id)))
    if (replaces.length > 0) done.push(t.autoReplaced(replaces.map(m => m.id)))
    if (adds.length > 0) done.push(t.autoAdded(adds.length))
    // The main conversation reads the auto entries beside the next prompt, to confirm or undo.
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
      await sync($)
      const note = resultNote(await read($, intents))
      return next(note ? { ...e, context: [...(e.context ?? []), note] } : e)
    }
    await sync($)
    if (!(await read($, isDirty))) return next(e)
    const block = `<intent-pane>\nThe intent pane for this worktree (the person's words are authoritative). Current list:\n${listText(
      await read($, purpose),
      await read($, intents),
    )}\n</intent-pane>`
    await update($, isDirty, () => false)

    return next({ ...e, context: [...(e.context ?? []), block] })
  })

  on('tool.call', { tool: 'mcp__intent-tracker__intent_add' }, async ($, e) => {
    if (fromSubagent(e)) return { deny: SUBAGENT_DENY }
    await sync($)
    const args = e as unknown as Record<string, unknown>
    const given = Array.isArray(args.intents) ? (args.intents as Record<string, unknown>[]) : []
    const newPurpose = str(args.purpose)
    const list = await read($, intents)
    const first = nextId(list)
    let phaseNumber = nextPhaseNumber(list)
    const items = given
      .map(g => ({
        summary: str(g.summary),
        check: str(g.check),
        kind: g.kind === 'limit' ? ('limit' as const) : ('goal' as const),
        source: str(g.source),
        parent: str(g.parent),
        replaces: str(g.replaces),
        phaseRef: str(g.phase),
        phaseTitles: Array.isArray(g.phases) ? (g.phases as unknown[]).map(str).filter(Boolean) : [],
      }))
      .filter(g => g.summary)
      .map((g, n) => ({
        ...g,
        id: String(first + n),
        // A new request's phases get their ids now, so its parts in this same call can name them.
        phases: g.phaseTitles.map(title => ({ id: `P${phaseNumber++}`, title })),
      }))
    // "+N" names the Nth item of this same call, so a request and its parts go in together.
    const parentOf = (ref: string) => (/^\+\d+$/.test(ref) ? String(first + Number(ref.slice(1)) - 1) : ref)
    const requestOf = (id: string): Intent | undefined => {
      const fresh = items.find(item => item.id === id && !item.parent)
      if (fresh) return { id, ai: fresh.summary, mine: '', check: '', isMet: false, evidence: '', kind: fresh.kind, phases: fresh.phases }
      return list.find(one => one.id === id && isLive(one) && isRequest(one))
    }
    const texts = await heard($)
    const problems: string[] = []
    const phaseOf = new Map<string, string>()
    items.forEach((item, n) => {
      const at = `item ${n + 1} ("${item.summary.slice(0, 40)}")`
      if (item.parent) {
        const request = requestOf(parentOf(item.parent))
        if (!request) problems.push(`${at}: parent "${item.parent}" is not a live request on the list.`)
        else if (kindOf(request) === 'limit') problems.push(`${at}: a limit has no parts.`)
        if (item.kind === 'limit') problems.push(`${at}: a part is always a goal; a limit is a request of its own, quoting the person.`)
        if (item.replaces) problems.push(`${at}: replaces is for requests, not parts.`)
        if (item.phaseTitles.length > 0) problems.push(`${at}: phases belong to a request, not a part.`)
        if (item.phaseRef && request) {
          const phase = findPhase(request, item.phaseRef)
          if (!phase || phase.closed) problems.push(`${at}: request ${request.id} has no live phase "${item.phaseRef}".`)
          else phaseOf.set(item.id, phase.id)
        }
        return
      }
      if (item.phaseRef) problems.push(`${at}: phase is for parts; give a request its phases with phases.`)
      if (item.phaseTitles.length > 0 && item.kind === 'limit') problems.push(`${at}: a limit has no phases.`)
      if (!item.source) {
        problems.push(
          `${at}: a request needs source, the person's own words that asked for it. If this is your own idea or a technical step, it does not go on the list (a step of a request is a part: give parent instead).`,
        )
      } else if (!said(texts, item.source)) {
        problems.push(
          `${at}: the person never said "${item.source}". Quote their words exactly as they wrote them (an ellipsis may join two pieces of one message).`,
        )
      }
      if (item.replaces && !list.some(one => one.id === item.replaces && isLive(one) && isRequest(one))) {
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
          history: [entry(at, 'claude', 'added', item.parent ? undefined : item.source)],
          ...(item.parent
            ? { parent: parentOf(item.parent), ...(phaseOf.has(item.id) ? { phase: phaseOf.get(item.id) } : {}) }
            : { kind: item.kind, source: item.source, ...(item.phases.length > 0 ? { phases: item.phases } : {}) }),
        }
        next.push(added)
        if (item.replaces) {
          next = close(next, item.replaces, { as: 'replaced', reason: item.source, by: 'person', at, replacedBy: item.id })
        }
      }
      return next
    })
    // Parts added to a request already on the list: tell the person.
    const later = items.filter(item => item.parent && list.some(one => one.id === parentOf(item.parent)))
    if (later.length > 0) $.ui.toast(strings(await read($, lang)).partsChanged('added', later.map(item => item.id)))
    await save($)
    await refreshTitle($)

    return { result: listText(await read($, purpose), await read($, intents)) }
  })

  on('tool.call', { tool: 'mcp__intent-tracker__intent_phase' }, async ($, e) => {
    if (fromSubagent(e)) return { deny: SUBAGENT_DENY }
    await sync($)
    const args = e as unknown as Record<string, unknown>
    const list = await read($, intents)
    const p = await read($, purpose)
    const requestId = str(args.request)
    const request = list.find(one => one.id === requestId && isRequest(one) && isLive(one))
    if (!request || kindOf(request) !== 'goal') return { deny: `"${requestId}" is not a live goal request.\n${listText(p, list)}` }
    const titles = Array.isArray(args.add) ? (args.add as unknown[]).map(str).filter(Boolean) : []
    const ref = str(args.id)
    const phase = ref ? findPhase(request, ref) : undefined
    if (ref && !phase) return { deny: `Request ${requestId} has no phase "${ref}".\n${listText(p, list)}` }
    if (!ref && titles.length === 0) return { deny: 'Give phases to add, or the id of a phase to change.' }
    const cancel = str(args.cancel)
    if (phase && args.done !== undefined && phaseParts(list, request, phase.id).length > 0) {
      return { deny: `Phase ${phase.id} has parts: it is done when they all are.` }
    }
    if (phase?.closed && !args.restore) return { deny: `Phase ${phase.id} is cancelled: restore it first.` }
    const position = typeof args.position === 'number' ? Math.max(1, Math.floor(args.position)) : null
    const at = await $.clock.now()
    let n = nextPhaseNumber(list)

    await update($, intents, l => {
      let next = l.map(one => {
        if (one.id !== requestId) return one
        let phases = [...(one.phases ?? [])]
        if (titles.length > 0) {
          const added = titles.map(title => ({ id: `P${n++}`, title }))
          // Insert before the live phase now at that position, else at the end.
          const anchor = position ? livePhases(one)[position - 1] : undefined
          const at2 = anchor ? phases.findIndex(x => x.id === anchor.id) : phases.length
          phases.splice(at2, 0, ...added)
        }
        if (phase) {
          phases = phases.map(x => {
            if (x.id !== phase.id) return x
            const changed = { ...x }
            if (str(args.title)) changed.title = str(args.title)
            if (args.done === true) changed.isDone = true
            if (args.done === false) delete changed.isDone
            if (cancel) changed.closed = { as: 'cancelled', reason: cancel, by: 'claude', at }
            if (args.restore === true) delete changed.closed
            return changed
          })
          if (position && titles.length === 0) {
            const moving = phases.find(x => x.id === phase.id)
            if (moving) {
              phases = phases.filter(x => x.id !== phase.id)
              const live = phases.filter(x => !x.closed)
              const anchor = live[position - 1]
              phases.splice(anchor ? phases.findIndex(x => x.id === anchor.id) : phases.length, 0, moving)
            }
          }
        }
        return { ...one, phases }
      })
      if (phase && cancel) next = close(next, requestId, { as: 'cancelled', reason: cancel, by: 'claude', at }, phase.id)
      if (phase && args.restore === true) {
        next = next.map(one => {
          if (one.parent !== requestId || one.phase !== phase.id || !one.closed?.isCascade) return one
          const back = { ...one }
          delete back.closed
          return withHistory(back, entry(at, 'claude', 'restored'))
        })
      }
      return next
    })
    $.ui.toast(strings(await read($, lang)).phasesChanged(requestId))
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
    const id = str(args.id)
    const evidence = str(args.evidence)
    const list = await read($, intents)
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
          ? withHistory({ ...item, isMet: true, evidence, isAuto: false }, entry(at, 'claude', item.isMet && item.isAuto ? 'confirmed' : 'met', evidence))
          : item,
      ),
    )
    await save($)
    await refreshTitle($)

    return { result: listText(await read($, purpose), await read($, intents)) }
  })

  on('tool.call', { tool: 'mcp__intent-tracker__intent_revise' }, async ($, e) => {
    if (fromSubagent(e)) return { deny: SUBAGENT_DENY }
    await sync($)
    const args = e as unknown as Record<string, unknown>
    const id = str(args.id)
    const newPurpose = str(args.purpose)
    const list = await read($, intents)
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
      if (args.phase !== undefined && (isRequest(one) || one.closed)) return { deny: `Only a live part moves between phases.` }
      if (typeof args.phase === 'string' && str(args.phase) && one.parent) {
        const request = list.find(item => item.id === one.parent)
        const target = request ? findPhase(request, str(args.phase)) : undefined
        if (!target || target.closed) return { deny: `Request ${one.parent} has no live phase "${str(args.phase)}".` }
      }
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
          if (typeof args.phase === 'string' && item.parent) {
            const request = l.find(x => x.id === item.parent)
            const target = str(args.phase) && request ? findPhase(request, str(args.phase)) : undefined
            if (target?.id !== item.phase) {
              changed = { ...changed }
              if (target) changed.phase = target.id
              else delete changed.phase
              changed = withHistory(changed, entry(at, 'claude', 'moved', target?.title))
            }
          }
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
        return next
      })
      // A part changed by Claude: tell the person (ticks show for themselves).
      if (one.parent) {
        const what = cancel
          ? 'cancelled'
          : args.restore === true
            ? 'restored'
            : args.phase !== undefined
              ? 'moved'
              : str(args.summary) || str(args.check)
                ? 'edited'
                : null
        if (what) $.ui.toast(strings(await read($, lang)).partsChanged(what, [id]))
      }
    }
    await save($)
    await refreshTitle($)

    return { result: listText(await read($, purpose), await read($, intents)) }
  })

  // Every main-loop call moves the stage line (plan, investigate, build, test,
  // fix, review). A finished test, build or report also reaches the model
  // with the open items beside it, so the pane is updated the moment the
  // result arrives.
  on('tool.call', async ($, e, next) => {
    const call = e as unknown as Record<string, unknown>
    if (String(call.tool).startsWith(`mcp__${P}__`) || fromSubagent(e) || !(await read($, isActive))) return next(e)
    const command = typeof call.command === 'string' ? call.command : ''
    const isVerify = call.tool === 'Bash' && VERIFY_COMMAND.test(command)
    const isTest = isVerify && TEST_COMMAND.test(command)
    const before = await read($, stage)
    const step = isVerify && !isTest ? 'build' : stageOf(call, isTest, before.isTestFailing)
    if (step) {
      const at = await $.clock.now()
      await update($, stage, old => advance(old, step, at))
    }
    if (!isResult(call)) return next(e)
    const done = await next(e)
    if ('deny' in done) return done
    // A test run that failed turns the next edits into fixing; a passing one ends that.
    if (isTest && call.run_in_background !== true) await update($, stage, old => ({ ...old, isTestFailing: done.isError === true }))
    await sync($)
    const note = resultNote(await read($, intents))
    if (!note) return done

    return { ...done, context: [...(done.context ?? []), note] }
  })

  // After each main-loop turn, a cheap model checks the turn against the list:
  // drift, and goals the turn's output shows passing that were left unticked.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId && e.reason === 'answer' && (await read($, isActive))) {
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
    // request with no parts counts as one.
    const barWidth = Math.max(6, Math.min(20, columns - 8))
    const filled = counted.total === 0 ? 0 : Math.round((counted.met / counted.total) * barWidth)
    const progressBar = (
      <Text dimColor>
        {'▓'.repeat(filled)}
        {'░'.repeat(barWidth - filled)} {counted.met}/{counted.total}
      </Text>
    )

    // Where the work is now, from the session's own calls: the current stage alone.
    // It sits under the current phase of the first open request that has
    // phases, else under the progress bar.
    const phasedRequest = openRequests.find(one => livePhases(one).length > 0)
    const stageText = (indent: string) =>
      where.now && (
        <Text bold color="cyan">
          {indent}
          {t.stage[where.now]}
        </Text>
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

    /** An open goal request with its parts under it, or a part. */
    const goalRow = (one: Intent, indent: string): JSX.Element => {
      const parts = partsOf(list, one.id)
      const metParts = parts.filter(part => part.isMet).length
      const mark = one.isMet ? '✓' : metParts > 0 ? '◐' : '○'
      const isAutoShown = one.isAuto === true
      return (
        <Box key={`goal-${one.id}`} flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text
              bold={!one.parent && !one.isMet}
              color={one.isMet ? (isAutoShown ? 'yellow' : 'green') : isAutoShown ? 'yellow' : undefined}
              wrap="wrap"
            >
              {indent}
              {mark} {one.id}. {one.ai}
              {parts.length > 0 ? ` ${metParts}/${parts.length}` : ''}
              {isAutoShown ? t.paren(t.autoMark) : ''}
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
          {phaseBlock(one, indent)}
        </Box>
      )
    }

    /** A request's parts: under its phases in order (✓ done, ● current, ○ later), else as they come. */
    const phaseBlock = (request: Intent, indent: string) => {
      const phases = livePhases(request)
      const parts = partsOf(list, request.id)
      if (phases.length === 0) return parts.map(part => goalRow(part, `${indent}  `))
      const current = currentPhase(list, request)
      const loose = parts.filter(part => !phases.some(phase => phase.id === part.phase))
      return (
        <Box flexDirection="column">
          {phases.map((phase, n) => {
            const inPhase = phaseParts(list, request, phase.id)
            const isPhaseNow = phase.id === current?.id
            const isFinished = isPhaseDone(list, request, phase)
            const met = inPhase.filter(part => part.isMet).length
            return (
              <Box key={`phase-${phase.id}`} flexDirection="column">
                <Text
                  bold={isPhaseNow}
                  color={isFinished ? 'green' : isPhaseNow ? 'cyan' : undefined}
                  dimColor={!isFinished && !isPhaseNow}
                  wrap="wrap"
                >
                  {indent}
                  {'  '}
                  {isFinished ? '✓' : isPhaseNow ? '●' : '○'} {t.phase} {n + 1} · {phase.title}
                  {inPhase.length > 0 ? ` ${met}/${inPhase.length}` : ''}
                </Text>
                {isPhaseNow && request.id === phasedRequest?.id && stageText(`${indent}      `)}
                {inPhase.map(part => goalRow(part, `${indent}    `))}
              </Box>
            )
          })}
          {loose.map(part => goalRow(part, `${indent}  `))}
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
            const isAutoShown = one.isAuto === true || parts.some(part => part.isAuto)
            return (
              <Box key={`done-${one.id}`} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text color={isAutoShown ? 'yellow' : 'green'} wrap="wrap">
                    ✓ {one.id}. {one.mine || one.ai}
                    {isAutoShown ? t.paren(t.autoMark) : ''}
                  </Text>
                  <Button
                    key={`details-${one.id}`}
                    label={details === one.id ? '▾' : '⋯'}
                    plain
                    dimColor
                    onPress={() => update($, shownDetails, v => (v === one.id ? null : one.id))}
                  />
                </Box>
                {parts.length === 0 && (
                  <Text dimColor wrap="wrap">
                    {'  '}
                    {t.evidence}
                    {t.colon}
                    {one.evidence}
                  </Text>
                )}
                {parts.map(part => (
                  <Box key={`done-part-${part.id}`}>
                    <Text color={part.isAuto ? 'yellow' : undefined} dimColor={!part.isAuto} wrap="wrap">
                      {'  '}✓ {part.id}. {part.mine || part.ai}
                      {part.isAuto ? t.paren(t.autoMark) : ''}
                    </Text>
                  </Box>
                ))}
                {details === one.id && detailsBlock({ ...one, evidence: '' }, '')}
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
          {!phasedRequest && stageText('')}
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
