// The list's model, free of the engine: what an item is, how progress is
// counted, how the person's words are checked, and the text Claude reads.
//
// Two layers. A REQUEST is what the person asked for, in their own words
// (`source`, checked against the conversation): a goal (an outcome) or a limit
// (something that must not happen). A PART is Claude's breakdown of one goal
// request into plain outcomes the person would recognise as pieces of what
// they asked (`parent`). Progress counts parts; a request with no parts counts
// as one. Claude's own ideas outside the requests never join the list.

import type { Actor, Closed, HistoryEntry, HistoryWhat, Intent, Phase, Purpose, Stage, StageKey } from '../types'

export const HISTORY_MAX = 20

export const kindOf = (one: Intent): 'goal' | 'limit' => one.kind ?? 'goal'
export const isLive = (one: Intent): boolean => !one.closed
export const isRequest = (one: Intent): boolean => !one.parent

/** The live parts of a request. */
export function partsOf(list: readonly Intent[], id: string): Intent[] {
  return list.filter(one => one.parent === id && isLive(one))
}

/** What progress counts: live goals with no live parts (parts, and requests not broken down). */
export function units(list: readonly Intent[]): Intent[] {
  return list.filter(one => isLive(one) && kindOf(one) === 'goal' && partsOf(list, one.id).length === 0)
}

export function progress(list: readonly Intent[]): { met: number; total: number } {
  const counted = units(list)
  return { met: counted.filter(one => one.isMet).length, total: counted.length }
}

/** A goal is done when it is ticked, or, broken down, when every live part (and every planned phase) is. */
export function isDone(list: readonly Intent[], one: Intent): boolean {
  const parts = partsOf(list, one.id)
  const isPartsDone = parts.length > 0 ? parts.every(part => part.isMet) : one.isMet
  return isPartsDone && livePhases(one).every(phase => isPhaseDone(list, one, phase))
}

export function livePhases(request: Intent): Phase[] {
  return (request.phases ?? []).filter(phase => !phase.closed)
}

/** The live parts of a request that fall in one phase. */
export function phaseParts(list: readonly Intent[], request: Intent, phaseId: string): Intent[] {
  return partsOf(list, request.id).filter(part => part.phase === phaseId)
}

/** A phase with parts is done when they all are; one without is done when marked so. */
export function isPhaseDone(list: readonly Intent[], request: Intent, phase: Phase): boolean {
  const parts = phaseParts(list, request, phase.id)
  return parts.length > 0 ? parts.every(part => part.isMet) : phase.isDone === true
}

/** The phase the work is in: the first one not done. */
export function currentPhase(list: readonly Intent[], request: Intent): Phase | undefined {
  return livePhases(request).find(phase => !isPhaseDone(list, request, phase))
}

export function nextPhaseNumber(list: readonly Intent[]): number {
  let max = 0
  for (const one of list) for (const phase of one.phases ?? []) max = Math.max(max, Number(phase.id.slice(1)) || 0)
  return max + 1
}

/** A phase named by its id ("P3") or by its position among the live phases ("2"). */
export function findPhase(request: Intent, ref: string): Phase | undefined {
  const all = request.phases ?? []
  const byId = all.find(phase => phase.id.toLowerCase() === ref.trim().toLowerCase())
  if (byId) return byId
  return /^\d+$/.test(ref.trim()) ? livePhases(request)[Number(ref.trim()) - 1] : undefined
}

export function nextId(list: readonly Intent[]): number {
  return list.reduce((max, one) => Math.max(max, Number(one.id) || 0), 0) + 1
}

export function withHistory(one: Intent, entry: HistoryEntry): Intent {
  return { ...one, history: [...(one.history ?? []), entry].slice(-HISTORY_MAX) }
}

export function entry(at: number, by: Actor, what: HistoryWhat, note?: string): HistoryEntry {
  return note ? { at, by, what, note } : { at, by, what }
}

/**
 * Closes an item and, for a request, its live parts with it (restored
 * together); with a phase id, the parts of that phase of request `id`.
 */
export function close(list: readonly Intent[], id: string, closed: Closed, phaseId?: string): Intent[] {
  return list.map(one => {
    if (!phaseId && one.id === id && isLive(one)) return withHistory({ ...one, closed }, entry(closed.at, closed.by, closed.as, closed.reason))
    if (one.parent === id && isLive(one) && (!phaseId || one.phase === phaseId)) {
      const cascade: Closed = { ...closed, as: 'cancelled', isCascade: true }
      delete cascade.replacedBy
      return withHistory({ ...one, closed: cascade }, entry(closed.at, closed.by, 'cancelled', closed.reason))
    }
    return one
  })
}

/** Brings a closed item back, with the parts that closed because it did. */
export function restore(list: readonly Intent[], id: string, at: number, by: Actor): Intent[] {
  return list.map(one => {
    if (one.id === id && one.closed) {
      const back = { ...one }
      delete back.closed
      return withHistory(back, entry(at, by, 'restored'))
    }
    if (one.parent === id && one.closed?.isCascade) {
      const back = { ...one }
      delete back.closed
      return withHistory(back, entry(at, by, 'restored'))
    }
    return one
  })
}

/** Text compared loosely: case, spacing, quote marks and end punctuation do not matter. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[「」『』“”‘’"'`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,!?;:。，！？；：、…]+|[\s.,!?;:。，！？；：、…]+$/g, '')
    .trim()
}

/** The person's prompts that the mod or the engine wrote for them, not words they said. */
const NOT_THE_PERSON = /^\s*(<task-notification|<system-reminder|<command-|\(Goals pane\)|（目標面板）|（目標パネル）)/

/**
 * The person's answers in a question dialog, from the tool result the model
 * reads (`"<question>"="<answer>"`, then any notes): the answers, never the
 * questions Claude wrote.
 */
export function dialogAnswers(result: string): string[] {
  const answers: string[] = []
  for (const m of result.matchAll(/"=\s*"((?:[^"\\]|\\.)*)"/g)) if (m[1]) answers.push(m[1])
  for (const m of result.matchAll(/user notes:\s*([^\n]+)/gi)) if (m[1]) answers.push(m[1])
  return answers
}

type Message = {
  role: string
  text: string
  toolResults?: readonly unknown[]
  toolUses?: readonly { tool: string; text?: string }[]
}

/** What the person themselves wrote: their prompts and dialog answers in the conversation, and their words in the pane. */
export function personTexts(messages: readonly Message[], pane: readonly string[]): string[] {
  const said: string[] = []
  for (const m of messages) {
    if (m.role === 'user' && m.text.trim() !== '' && !(m.toolResults && m.toolResults.length > 0) && !NOT_THE_PERSON.test(m.text)) {
      said.push(m.text)
    }
    if (m.role === 'assistant') {
      for (const use of m.toolUses ?? []) if (use.tool === 'AskUserQuestion' && use.text) said.push(...dialogAnswers(use.text))
    }
  }
  return [...said, ...pane.filter(text => text.trim() !== '')]
}

/**
 * Whether the person said this: the quote (its pieces either side of an
 * ellipsis) appears in one thing they wrote.
 */
export function said(texts: readonly string[], quote: string): boolean {
  const pieces = quote
    .split(/…|\.\.\./)
    .map(normalize)
    .filter(piece => piece.length > 0)
  if (pieces.length === 0 || pieces.join('').length < 2) return false
  return texts.some(text => {
    const plain = normalize(text)
    return pieces.every(piece => plain.includes(piece))
  })
}

function statusText(list: readonly Intent[], one: Intent): string {
  const auto = ' (auto, unconfirmed)'
  if (one.closed) {
    const how =
      one.closed.as === 'replaced' ? `replaced by ${one.closed.replacedBy ?? '?'}` : `cancelled by ${one.closed.by}`
    return `${how}${one.closed.isAuto ? auto : ''}: ${one.closed.reason}`
  }
  if (kindOf(one) === 'limit') return one.broken ? `BROKEN${one.broken.isAuto ? auto : ''}: ${one.broken.evidence}` : 'holding'
  const parts = partsOf(list, one.id)
  if (parts.length > 0) {
    const met = parts.filter(part => part.isMet).length
    return met === parts.length ? `met (all ${met} parts)` : `open (${met}/${parts.length} parts met)`
  }
  if (one.isMet) return `met${one.isAuto ? auto : ''}`
  return one.isAuto ? `open (added${auto})` : 'open'
}

function line(list: readonly Intent[], one: Intent, isWithHistory: boolean): string {
  const role = one.parent ? `part of ${one.parent}` : `request · ${kindOf(one)}`
  const fields = [`${one.id}. [${role} · ${statusText(list, one)}] ${one.ai}`]
  if (one.mine) fields.push(`person's words: ${one.mine}`)
  if (one.source && !one.parent) fields.push(`source: "${one.source}"`)
  fields.push(`check: ${one.check || '(none)'}`)
  if (one.isMet && kindOf(one) === 'goal' && partsOf(list, one.id).length === 0) fields.push(`evidence: ${one.evidence}`)
  if (isWithHistory && one.history && one.history.length > 0) {
    fields.push(
      'history: ' +
        one.history
          .slice(-3)
          .map(h => `${h.what} by ${h.by}${h.note ? ` (${h.note.slice(0, 80)})` : ''}`)
          .join('; '),
    )
  }
  return fields.join(' | ')
}

/** The list as Claude reads it: requests with their parts under them, then what was closed. */
export function listText(p: Purpose, list: readonly Intent[], isWithHistory = false): string {
  const { met, total } = progress(list)
  const lines = [`Purpose: ${p.ai || '(unset)'}${p.mine ? ` | person's words: ${p.mine}` : ''}`]
  lines.push(`Progress: ${met}/${total} goals met (parts count; a request with no parts counts as one)`)
  for (const request of list.filter(one => isRequest(one) && isLive(one))) {
    lines.push(line(list, request, isWithHistory))
    const phases = livePhases(request)
    const now = currentPhase(list, request)
    phases.forEach((phase, n) => {
      const state = isPhaseDone(list, request, phase) ? 'done' : phase.id === now?.id ? 'current' : 'not started'
      lines.push(`  Phase ${phase.id} (#${n + 1}, ${state}): ${phase.title}`)
      for (const part of phaseParts(list, request, phase.id)) lines.push(`    ${line(list, part, isWithHistory)}`)
    })
    const loose = partsOf(list, request.id).filter(part => !phases.some(phase => phase.id === part.phase))
    if (phases.length > 0 && loose.length > 0) lines.push('  (in no phase)')
    for (const part of loose) lines.push(`  ${phases.length > 0 ? '  ' : ''}${line(list, part, isWithHistory)}`)
  }
  // A live part whose request is gone (an older list): shown on its own.
  for (const orphan of list.filter(one => one.parent && isLive(one) && !list.some(r => r.id === one.parent && isLive(r)))) {
    lines.push(line(list, orphan, isWithHistory))
  }
  const closed = list.filter(one => !isLive(one))
  if (closed.length > 0) {
    lines.push('Closed (not counted):')
    for (const one of closed) lines.push(`  ${line(list, one, isWithHistory)}`)
  }
  return lines.join('\n')
}

/**
 * Where the work is now, worked out from the session's own tool calls, no
 * model involved: plan, investigate, build, test, fix (building again after a
 * failed test), review.
 */
export const NO_STAGE: Stage = { now: null, seen: [], at: 0, isTestFailing: false }

const REVIEW = /\b(review|audit|verify|verification|critique)\b/i
const PLAN = /\bplan(ning)?\b/i

export function stageOf(call: Record<string, unknown>, isTest: boolean, isTestFailing: boolean): StageKey | null {
  const tool = String(call.tool)
  const words = `${String(call.subagent_type ?? '')} ${String(call.description ?? '')} ${String(call.skill ?? '')}`
  if (tool === 'EnterPlanMode' || tool === 'ExitPlanMode') return 'plan'
  if (tool === 'Agent' || tool === 'Task' || tool === 'Skill') {
    if (/explore/i.test(String(call.subagent_type ?? ''))) return 'investigate'
    if (isTest || /test-runner|\btests?\b/i.test(words)) return 'test'
    if (REVIEW.test(words)) return 'review'
    if (PLAN.test(words)) return 'plan'
    return null
  }
  if (['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'LSP'].includes(tool)) return 'investigate'
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return isTestFailing ? 'fix' : 'build'
  if (tool === 'Bash' && isTest) return 'test'
  return null
}

/** The trail keeps each change of stage (the last eight), so the current one is always last. */
export function advance(stage: Stage, next: StageKey, at: number): Stage {
  const seen = stage.seen[stage.seen.length - 1] === next ? stage.seen : [...stage.seen, next].slice(-8)
  return { ...stage, now: next, at, seen }
}
