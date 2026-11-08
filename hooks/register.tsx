import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Drift, Intent, Purpose } from '../types'
import { ago, asLang, DEFAULT_LANG, langLabel, langName, strings } from './i18n'
import type { Lang } from './i18n'

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
/**
 * Whether this session has a person who can see the pane: false for a `-p`
 * run, the SDK and other headless sessions, where the mod stays out of the way
 * (no instructions, no tools, no drift check).
 */
const isActive = atom({ plugin: 'intent-tracker', key: 'isActive' } as const, true)
/** Whether the finished goals are expanded in the pane (folded by default). */
const isDoneOpen = atom({ plugin: 'intent-tracker', key: 'isDoneOpen' } as const, false)

/** A subagent's (or teammate's) call: only the main conversation edits the list. */
function fromSubagent(e: unknown): boolean {
  const agentId = (e as { agentId?: unknown }).agentId
  return typeof agentId === 'string' && agentId !== ''
}
const SUBAGENT_DENY = 'Only the main conversation updates the intent pane; leave it to the main agent.'

/** The model the drift check runs on (the session's own model does the rest). */
const DRIFT_MODEL = 'haiku'

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
A pane beside the chat shows the person, in plain ${language}, what the work in this worktree is for and which goals are met, so they do not get lost when the conversation turns technical. The list is kept per worktree across sessions. Keep it accurate and quiet (do not narrate these calls):
- When the person states the task, or the task changes, call ${TOOL('intent_add')} with a one-line \`purpose\` and the goals. Each goal: \`summary\` is one plain ${language} sentence a non-programmer understands (no file names, SHAs, flags or jargon); \`check\` is the concrete step that proves it (a test that passes, a behaviour observed, a diff condition), in ${language}, identifiers allowed. Evidence is in ${language} too. Goals are outcomes the person wants, not your sub-steps: usually 1-5. Do not re-add goals already on the list.
- Call ${TOOL('intent_met')} only after a goal's check has actually been run or observed and passed, with the evidence. Never on intent, partial work or an unrun check. If later work breaks a met goal, call ${TOOL('intent_revise')} with reopen: true.
- To see the current list, call ${TOOL('intent_list')}; never call another intent tool just to read it.
- The person may type their own words for the purpose or a goal; they reach you as context beside their prompt. Their words are the authority: when your summary or check diverges from them, revise yours to match, never the reverse.`

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
      'Add goals to the intent pane (and optionally set the purpose). Use when the person states a task or the task changes.',
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
              check: { type: 'string', description: 'The concrete verification step that proves it.' },
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
    description: "Tick a goal in the intent pane after its check actually ran and passed.",
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
      "Change the purpose line, or a goal's summary or check (e.g. to match the person's own words), or reopen a met goal whose check no longer holds. Never touches the person's own words.",
    inputSchema: {
      type: 'object',
      properties: {
        purpose: { type: 'string', description: "New plain purpose line in the pane's language." },
        id: { type: 'string', description: 'The goal to change; omit when changing only the purpose.' },
        summary: { type: 'string' },
        check: { type: 'string' },
        reopen: { type: 'boolean' },
      },
    },
    isDeferred: false,
  },
] as const

function listText(p: Purpose, list: readonly Intent[]): string {
  const met = list.filter(one => one.isMet).length
  const lines = [`Purpose: ${p.ai || '(unset)'}${p.mine ? ` | person's words: ${p.mine}` : ''}`]
  lines.push(`Goals met: ${met}/${list.length}`)
  for (const one of list) {
    lines.push(
      `${one.id}. [${one.isMet ? 'met' : 'open'}] ${one.ai}` +
        (one.mine ? ` | person's words: ${one.mine}` : '') +
        ` | check: ${one.check}` +
        (one.isMet ? ` | evidence: ${one.evidence}` : ''),
    )
  }

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
  const list = await read($, intents)
  const met = list.filter(one => one.isMet).length
  const t = strings(await read($, lang))
  const title = list.length === 0 ? t.title : `${t.title} ${met}/${list.length}`
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

function parseVerdict(text: string): { isOnTrack: boolean; note: string; isByUser: boolean } | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const value = JSON.parse(match[0]) as Record<string, unknown>
    return {
      isOnTrack: value.onTrack !== false,
      note: str(value.note),
      isByUser: value.byUser === true,
    }
  } catch {
    return null
  }
}

async function checkDrift($: EngineInterface): Promise<void> {
  const list = await read($, intents)
  if (list.length === 0) return
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

  const ask = asked.text.slice(0, 2000)
  const work: string[] = []
  for (const m of messages.slice(start + 1)) {
    if (m.role !== 'assistant') continue
    if (m.text.trim()) work.push(`said: ${m.text.trim().slice(0, 600)}`)
    for (const use of m.toolUses) {
      if (use.tool.startsWith(`mcp__${P}__`)) continue
      work.push(`${use.tool}: ${JSON.stringify(use.input).slice(0, 300)}`)
    }
  }
  if (work.length === 0) return

  const answer = await $.model.complete({
    model: DRIFT_MODEL,
    maxTokens: 200,
    system:
      "You check whether an AI coding assistant's latest turn stayed on the goals a person set for this work. Reply with JSON only.",
    prompt:
      `${listText(p, list)}\n\nThe person's latest message:\n${ask}\n\nWhat the assistant did this turn:\n${work.join('\n').slice(0, 8000)}\n\n` +
      'Work that serves any goal counts as on track: investigation, setup, verification, fixing what blocks a goal, and answering a direct question about the goals. ' +
      'Flag only work clearly unrelated to every goal and to the purpose.\n' +
      'Reply {"onTrack": true} or {"onTrack": false, "byUser": <true if the person\'s latest message itself asked for that off-list work>, ' +
      `"note": "<one short plain sentence in ${langName(await read($, lang))} naming the off-list work, no jargon>"}`,
  })
  if (!answer.isAnswered) return

  const verdict = parseVerdict(answer.text)
  if (!verdict || verdict.isOnTrack || !verdict.note) return
  await sync($)
  await update($, drift, () => ({ note: verdict.note, isByUser: verdict.isByUser }))
  await save($)
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
    if (e.command || e.isMeta || !(await read($, isActive))) return next(e)
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
    if (newPurpose) await update($, purpose, p => ({ ...p, ai: newPurpose }))
    await update($, intents, list => {
      let n = list.reduce((max, one) => Math.max(max, Number(one.id) || 0), 0)
      const added = given
        .map(g => ({ ai: str(g.summary), check: str(g.check) }))
        .filter(g => g.ai)
        .map(g => {
          n += 1
          return { id: String(n), ai: g.ai, mine: '', check: g.check, isMet: false, evidence: '' }
        })
      return [...list, ...added]
    })
    await save($)
    await refreshTitle($)

    return { result: listText(await read($, purpose), await read($, intents)) }
  })

  on('tool.call', { tool: 'mcp__intent-tracker__intent_list' }, async $ => {
    await sync($)

    return { result: listText(await read($, purpose), await read($, intents)) }
  })

  on('tool.call', { tool: 'mcp__intent-tracker__intent_met' }, async ($, e) => {
    if (fromSubagent(e)) return { deny: SUBAGENT_DENY }
    await sync($)
    const args = e as unknown as Record<string, unknown>
    const id = str(args.id)
    const evidence = str(args.evidence)
    const list = await read($, intents)
    if (!list.some(one => one.id === id)) return { deny: `No goal with id "${id}".\n${listText(await read($, purpose), list)}` }
    if (!evidence) return { deny: 'evidence is required: name the check you ran and what it showed.' }
    await update($, intents, l => l.map(one => (one.id === id ? { ...one, isMet: true, evidence } : one)))
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
    if (!id && !newPurpose) return { deny: `Give a goal id, a purpose, or both.\n${listText(await read($, purpose), list)}` }
    if (id && !list.some(one => one.id === id)) return { deny: `No goal with id "${id}".\n${listText(await read($, purpose), list)}` }
    if (newPurpose) await update($, purpose, p => ({ ...p, ai: newPurpose }))
    await update($, intents, l =>
      l.map(one => {
        if (one.id !== id) return one
        const next = { ...one }
        if (str(args.summary)) next.ai = str(args.summary)
        if (str(args.check)) next.check = str(args.check)
        if (args.reopen === true) {
          next.isMet = false
          next.evidence = ''
        }
        return next
      }),
    )
    await save($)
    await refreshTitle($)

    return { result: listText(await read($, purpose), await read($, intents)) }
  })

  // After each main-loop turn, a cheap model checks the turn against the list.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId && e.reason === 'answer' && (await read($, isActive))) {
      $.clock.after(0, () => {
        void checkDrift($).catch(() => undefined)
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
    const t = strings(chosen)
    const mainModel = modelName(await $.session.model().catch(() => t.mainSession))
    const columns = e.props.bodyColumns ?? 40
    const open = list.filter(one => !one.isMet)
    const done = list.filter(one => one.isMet)

    const choose = async (next: Lang) => {
      await update($, lang, () => next)
      await update($, editing, () => null)
      await $.store.set(LANG_KEY, next)
      await refreshTitle($)
    }

    const saveMine = (target: string) => (value: string) => {
      void (async () => {
        const text = value.trim()
        await sync($)
        if (target === 'purpose') await update($, purpose, old => ({ ...old, mine: text }))
        else await update($, intents, l => l.map(one => (one.id === target ? { ...one, mine: text } : one)))
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
    const meta = [
      ...(lastAt === null ? [] : [ago(t, lastAt, Math.max(nowMs, lastAt))]),
      mainModel,
      `${t.driftShort} ${modelName(DRIFT_MODEL)}`,
    ].join(' · ')
    const footer = (
      <Box flexDirection="column">
        {rule}
        <Box flexDirection="row" flexWrap="wrap">
          <Text dimColor wrap="wrap">{`${meta} · `}</Text>
          <Button
            key="lang"
            label={`🌐 ${langLabel(chosen)}`}
            plain
            dimColor
            onPress={() => update($, editing, () => (isPicking ? null : 'lang'))}
          />
        </Box>
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

    // Progress at a glance (the count is in the title too).
    const barWidth = Math.max(6, Math.min(20, columns - 8))
    const filled = list.length === 0 ? 0 : Math.round((done.length / list.length) * barWidth)
    const progress = (
      <Text dimColor>
        {'▓'.repeat(filled)}
        {'░'.repeat(barWidth - filled)} {done.length}/{list.length}
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
              await sync($)
              await update($, intents, l => {
                const n = l.reduce((max, one) => Math.max(max, Number(one.id) || 0), 0) + 1
                return [...l, { id: String(n), ai: off.note, mine: '', check: '', isMet: false, evidence: '' }]
              })
              await update($, drift, () => null)
              await update($, isDirty, () => true)
              await save($)
              await refreshTitle($)
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

    // What is still open, in full: the goal, the person's words, the check.
    const openGoals = open.map(one => (
      <Box key={`goal-${one.id}`} flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold wrap="wrap">
            ○ {one.id}. {one.ai}
          </Text>
          {edit !== one.id && pencil(one.id)}
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
        <Text dimColor wrap="wrap">
          {'  '}
          {t.check}
          {t.colon}
          {one.check || t.noCheck}
        </Text>
      </Box>
    ))

    // What is done, folded to one line; open it for each goal and its evidence.
    const doneGroup = done.length > 0 && (
      <Box flexDirection="column">
        <Button
          key="done-toggle"
          label={`✓ ${t.doneGroup(done.length)} ${isDoneShown ? '▾' : '▸'}`}
          plain
          dimColor
          onPress={() => update($, isDoneOpen, v => !v)}
        />
        {isDoneShown &&
          done.map(one => (
            <Box key={`done-${one.id}`} flexDirection="column">
              <Text color="green" wrap="wrap">
                ✓ {one.id}. {one.mine || one.ai}
              </Text>
              <Text dimColor wrap="wrap">
                {'  '}
                {t.evidence}
                {t.colon}
                {one.evidence}
              </Text>
            </Box>
          ))}
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
          {list.length > 0 && progress}
        </Box>
        {driftBox}
        {openGoals}
        {doneGroup}
        {clearRow}
        {footer}
      </Box>
    )
  })
}
