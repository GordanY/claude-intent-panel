// The list's model, free of the engine: what an item is, how progress is
// counted, how the person's words are checked, and the text Claude reads.
//
// Two layers. A REQUEST is what the person asked for, in their own words
// (`source`, checked against the conversation): an outcome. ("Don't touch X"
// is the outcome "X stays untouched".) A PART is Claude's breakdown of one goal
// request into plain outcomes the person would recognise as pieces of what
// they asked (`parent`). Progress counts parts; a request with no parts counts
// as one. Claude's own ideas outside the requests never join the list.
//
// Parts are ordered; any number may be ACTIVE at once (Claude working on it,
// or a subagent sent for it), each with its own live activity. A part the
// work shows no longer applies is flagged STALE until Claude re-plans.

import type { Actor, Closed, HistoryEntry, HistoryWhat, Intent, Purpose, Stage, StageKey } from '../types'

export const HISTORY_MAX = 20

/**
 * Lists saved before limits were removed (0.14.3): a limit becomes an ordinary
 * open goal, its "broken" note dropped (its words and check are kept).
 */
export function withoutLimits(list: readonly Intent[]): Intent[] {
  if (!list.some(one => one.kind || one.broken)) return [...list]
  return list.map(one => {
    if (!one.kind && !one.broken) return one
    const goal = { ...one }
    delete goal.kind
    delete goal.broken
    return goal
  })
}
export const isLive = (one: Intent): boolean => !one.closed
export const isRequest = (one: Intent): boolean => !one.parent

/** The live parts of a request. */
export function partsOf(list: readonly Intent[], id: string): Intent[] {
  return list.filter(one => one.parent === id && isLive(one))
}

/** What progress counts: live goals with no live parts (parts, and requests not broken down). */
export function units(list: readonly Intent[]): Intent[] {
  return list.filter(one => isLive(one) && partsOf(list, one.id).length === 0)
}

export function progress(list: readonly Intent[]): { met: number; total: number } {
  const counted = units(list)
  return { met: counted.filter(one => one.isMet).length, total: counted.length }
}

/** A goal is done when it is ticked, or, broken down, when every live part is. */
export function isDone(list: readonly Intent[], one: Intent): boolean {
  const parts = partsOf(list, one.id)
  return parts.length > 0 ? parts.every(part => part.isMet) : one.isMet
}

/** The letter for the nth part of a request: a, b, … z, then -27, -28… */
export function letterAt(n: number): string {
  return n < 26 ? String.fromCharCode(97 + n) : `-${n + 1}`
}

/**
 * Gives every part without a letter the next one unused under its request,
 * in list order, so labels stay put when parts are cancelled or moved.
 */
export function withLetters(list: readonly Intent[]): Intent[] {
  const used = new Map<string, Set<string>>()
  for (const one of list) if (one.parent && one.letter) (used.get(one.parent) ?? used.set(one.parent, new Set()).get(one.parent))?.add(one.letter)
  if (list.every(one => !one.parent || one.letter)) return [...list]
  return list.map(one => {
    if (!one.parent || one.letter) return one
    const taken = used.get(one.parent) ?? used.set(one.parent, new Set()).get(one.parent) ?? new Set<string>()
    let n = 0
    while (taken.has(letterAt(n))) n += 1
    taken.add(letterAt(n))
    return { ...one, letter: letterAt(n) }
  })
}

/** How the person sees an item: a request by its number, a part by its request's number and its letter ("1b"). */
export function labelOf(list: readonly Intent[], one: Intent): string {
  if (!one.parent) return one.id
  if (one.letter) return `${one.parent}${one.letter}`
  const siblings = list.filter(x => x.parent === one.parent && (isLive(x) || x.id === one.id))
  const n = Math.max(0, siblings.findIndex(x => x.id === one.id))
  return `${one.parent}${n < 26 ? String.fromCharCode(97 + n) : `-${n + 1}`}`
}

/** An item named by its id ("3") or its label ("1b"). */
export function resolveId(list: readonly Intent[], ref: string): string | undefined {
  const r = ref.trim().toLowerCase()
  if (list.some(one => one.id === r)) return r
  // Letters are never reused, so a label names one part; older parts without one, a live part first.
  return (list.find(one => one.parent && isLive(one) && labelOf(list, one) === r) ?? list.find(one => one.parent && labelOf(list, one) === r))?.id
}

/** Moves a part to a 1-based position among its request's live parts. */
export function movePart(list: readonly Intent[], id: string, position: number): Intent[] {
  const part = list.find(one => one.id === id)
  if (!part?.parent) return [...list]
  const rest = list.filter(one => one.id !== id)
  const siblings = rest.filter(one => one.parent === part.parent && isLive(one))
  if (siblings.length === 0) return [...list]
  const p = Math.min(Math.max(1, Math.floor(position)), siblings.length + 1)
  const last = siblings[siblings.length - 1] as Intent
  const at = p <= siblings.length ? rest.indexOf(siblings[p - 1] as Intent) : rest.indexOf(last) + 1
  rest.splice(at, 0, part)
  return rest
}

/** The next request number: requests count 1, 2, 3… (older lists' numeric part ids are skipped over). */
export function nextId(list: readonly Intent[]): number {
  return list.reduce((max, one) => Math.max(max, Number(one.id) || 0), 0) + 1
}

/** The next part id ("p1", "p2"…): parts have their own ids, so they never use up a request number. */
export function nextPartId(list: readonly Intent[]): number {
  return list.reduce((max, one) => Math.max(max, /^p\d+$/.test(one.id) ? Number(one.id.slice(1)) : 0), 0) + 1
}

export function withHistory(one: Intent, entry: HistoryEntry): Intent {
  return { ...one, history: [...(one.history ?? []), entry].slice(-HISTORY_MAX) }
}

export function entry(at: number, by: Actor, what: HistoryWhat, note?: string): HistoryEntry {
  return note ? { at, by, what, note } : { at, by, what }
}

/** Closes an item and, for a request, its live parts with it (restored together). */
export function close(list: readonly Intent[], id: string, closed: Closed): Intent[] {
  return list.map(one => {
    if (one.id === id && isLive(one)) return withHistory({ ...one, closed, isActive: false }, entry(closed.at, closed.by, closed.as, closed.reason))
    if (one.parent === id && isLive(one)) {
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

/** The shortest quote that counts as the person's words: CJK characters weigh two, others one. */
export const MIN_QUOTE = 6

/** How much text a quote carries: CJK characters (one word each) weigh two. */
export function weight(text: string): number {
  let n = 0
  for (const ch of text.replace(/\s+/g, '')) n += /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3\uf900-\ufaff]/.test(ch) ? 2 : 1
  return n
}

/** Whether two quotes are the same words: one contains the other, and the shorter is long enough to tell. */
export function sameWords(a: string, b: string): boolean {
  const x = normalize(a)
  const y = normalize(b)
  if (!x || !y) return false
  const shorter = x.length <= y.length ? x : y
  return weight(shorter) >= MIN_QUOTE && (x.includes(y) || y.includes(x))
}

/** Cuts text to n characters without splitting an emoji or other surrogate pair. */
export function clip(text: string, n: number): string {
  const chars = Array.from(text)
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : text
}

/**
 * What in a message is the person's own writing: fenced code, pasted
 * material and machine-added blocks are not.
 */
export function ownWriting(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<(pasted_content|system-reminder|command-[a-z-]+|local-command-[a-z-]+)\b[\s\S]*?<\/\1[^>]*>/g, ' ')
}

/** Text compared loosely: case, spacing, quote marks and end punctuation do not matter. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[「」『』“”‘’"'`*_]/g, '')
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
  for (const m of result.matchAll(/\bnotes:\s*([\s\S]+?)(?=, "[^"]*"=|\. You can now continue|$)/gi)) if (m[1]) answers.push(m[1])
  return answers
}

/**
 * Messages the person typed while a turn ran: the engine delivers each inside
 * a later user message (beside tool results), wrapped in a fixed sentence.
 */
export function midTurnTexts(text: string): string[] {
  const found: string[] = []
  const pattern = /The user sent a new message while you were working:\n([\s\S]*?)(?=\n\n(?:This is how Claude Code surfaces|IMPORTANT:)|$)/g
  for (const m of text.matchAll(pattern)) if (m[1]?.trim()) found.push(m[1].trim())
  return found
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
      said.push(ownWriting(m.text))
    }
    // Typed over a running turn: found in the transcript too, so they still count after a reload or resume.
    if (m.role === 'user') said.push(...midTurnTexts(m.text))
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
  if (pieces.length === 0) return false
  // Too short to tell apart ("ok", "好的", "pick 1"): it counts only as a whole message of the person's,
  // never as a piece of a longer one.
  if (weight(pieces.join('')) < MIN_QUOTE) return pieces.length === 1 && texts.some(text => normalize(text) === pieces[0])
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
  const parts = partsOf(list, one.id)
  if (parts.length > 0) {
    const met = parts.filter(part => part.isMet).length
    return met === parts.length ? `met (all ${met} parts)` : `open (${met}/${parts.length} parts met)`
  }
  if (one.isMet) {
    const how = one.byPerson ? ' (confirmed by the person)' : one.isAuto ? ' (seen in output)' : ''
    return `met${how}${one.unmatched ? ` [EVIDENCE NOT MATCHED: ${one.unmatched}; rerun the check or reopen]` : ''}`
  }
  const flags = [
    one.isActive ? 'ACTIVE' : '',
    isUnclear(one) ? 'CHECK UNCLEAR: no result could prove it, rewrite it' : '',
    isYourCall(one) ? "PERSON'S CALL: only their answer can confirm it, ask them" : '',
    one.isStale ? 'STALE: may no longer apply, re-plan' : '',
    one.atEnd ? 'checked last' : '',
    partsOf(list, one.id).length === 0 && !isFalsifiable(one.check) ? 'VAGUE CHECK: rewrite it as something that could fail' : '',
  ].filter(Boolean).join(', ')
  return `${one.isAuto ? `open (added${auto})` : 'open'}${flags ? ` [${flags}]` : ''}`
}

function line(list: readonly Intent[], one: Intent, isWithHistory: boolean): string {
  const role = one.parent ? `part ${labelOf(list, one)} of ${one.parent}` : 'request · goal'
  const fields = [`${one.id}. [${role} · ${statusText(list, one)}] ${one.ai}`]
  if (one.agent) fields.push(`subagent: "${one.agent}"`)
  if (one.mine) fields.push(`person's words: ${one.mine}`)
  if (one.source) fields.push(`${one.parent ? "person's follow-up" : 'source'}: "${one.source}"`)
  fields.push(`check: ${one.check || '(none)'}`)
  if (one.isMet && partsOf(list, one.id).length === 0) fields.push(`evidence: ${one.evidence}`)
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

/** How many closed items the list text still carries. */
export const CLOSED_SHOWN = 5

/** The list as Claude reads it: requests with their parts under them, then what was closed. */
export function listText(p: Purpose, list: readonly Intent[], isWithHistory = false): string {
  const { met, total } = progress(list)
  const lines = [`Purpose: ${p.ai || '(unset)'}${p.mine ? ` | person's words: ${p.mine}` : ''}`]
  lines.push(`Progress: ${met}/${total} parts met (a request with no parts counts as one)`)
  for (const request of list.filter(one => isRequest(one) && isLive(one))) {
    lines.push(line(list, request, isWithHistory))
    for (const part of partsOf(list, request.id)) lines.push(`  ${line(list, part, isWithHistory)}`)
  }
  // A live part whose request is gone (an older list): shown on its own.
  for (const orphan of list.filter(one => one.parent && isLive(one) && !list.some(r => r.id === one.parent && isLive(r)))) {
    lines.push(line(list, orphan, isWithHistory))
  }
  // Only the latest closed items ride along; the older ones are a count, so the text stays short.
  const closed = list.filter(one => !isLive(one))
  if (closed.length > 0) {
    lines.push('Closed (not counted):')
    for (const one of closed.slice(-CLOSED_SHOWN)) lines.push(`  ${line(list, one, isWithHistory)}`)
    if (closed.length > CLOSED_SHOWN) lines.push(`  (+${closed.length - CLOSED_SHOWN} older closed items)`)
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
  // Waiting on the person: a question asked, or a plan put up for approval.
  if (tool === 'AskUserQuestion') return 'ask'
  if (tool === 'ExitPlanMode') return 'approve'
  if (tool === 'EnterPlanMode') return 'plan'
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

/** Whether a reply ends by asking the person something: its last line ends in a question mark. */
export function endsWithQuestion(text: string): boolean {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  const last = (lines[lines.length - 1] ?? '').replace(/[\s*_`)）」』"'~]+$/u, '')
  return /[?？]$/.test(last)
}

/** A short key of the live items for a refusal: "1, 7 (7a), 12 (12a, 12b)", never the whole list. */
export function idKey(list: readonly Intent[]): string {
  return list
    .filter(one => isRequest(one) && isLive(one))
    .map(request => {
      const parts = partsOf(list, request.id).map(part => labelOf(list, part))
      return parts.length > 0 ? `${request.id} (${parts.join(', ')})` : request.id
    })
    .join(', ')
}

type Core = { purpose: Purpose; intents: Intent[]; drift: unknown }

/** Whether two values hold the same content. */
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Three-way merge of the list: what this session holds (local) and what is
 * saved now (stored), both against the copy this session last read or wrote
 * (base). A side that did not change an item takes the other's; when both
 * changed it, this session's change wins. An item gone from the store while
 * unchanged here was cleared elsewhere and goes.
 */
export function merge3<C extends Core>(base: C | null, local: C, stored: C | null): C {
  if (!stored) return base && same(base, local) ? ({ ...local, purpose: { ai: '', mine: '' }, intents: [], drift: null } as C) : local
  if (!base) return local
  const pick = <T,>(b: T, l: T, s: T): T => (same(l, b) ? s : l)
  const byId = (items: readonly Intent[]) => new Map(items.map(one => [one.id, one]))
  const b = byId(base.intents)
  const s = byId(stored.intents)
  const out: Intent[] = []
  for (const one of local.intents) {
    const was = b.get(one.id)
    const now = s.get(one.id)
    if (!was) out.push(one)
    else if (same(one, was)) {
      if (now) out.push(now)
    } else if (now) {
      // This session changed the item and so may the other: this session's version wins, but the person's
      // own words are merged field by field, so a word written in either session is never lost.
      out.push({ ...one, mine: mergeWords(was.mine, one.mine, now.mine) })
    } else out.push(one)
  }
  for (const one of stored.intents) if (!out.some(x => x.id === one.id) && !b.has(one.id)) out.push(one)
  const purpose = pick(base.purpose, local.purpose, stored.purpose)
  return {
    ...local,
    purpose: { ...purpose, mine: mergeWords(base.purpose.mine, local.purpose.mine, stored.purpose.mine) },
    drift: pick(base.drift, local.drift, stored.drift),
    intents: out,
  }
}

/** The person's words from two sides: one side's change wins over no change; two different changes are both kept. */
export function mergeWords(base: string, a: string, b: string): string {
  if (a === b) return a
  if (a === base) return b
  if (b === base) return a
  return joinWords(a, b)
}

/** Two texts of the person's, each kept once, joined with "; ". */
export function joinWords(...texts: readonly string[]): string {
  const seen: string[] = []
  for (const text of texts) {
    for (const piece of text.split(/;\s*/).map(x => x.trim()).filter(Boolean)) if (!seen.includes(piece)) seen.push(piece)
  }
  return seen.join('; ')
}

/**
 * The list in brief: open requests with their open parts (finished parts
 * as a count), and every finished request folded into one line.
 * Checks, evidence and sources are intent_list's.
 */
export function briefText(p: Purpose, list: readonly Intent[]): string {
  const { met, total } = progress(list)
  const lines = [`Purpose: ${p.mine || p.ai || '(unset)'}`, `Progress: ${met}/${total} parts met. Details: intent_list.`]
  const state = (one: Intent) =>
    (one.isMet ? 'met' : one.isStale ? 'stale' : one.isActive ? 'active' : one.isAuto ? 'open, auto' : 'open') +
    (one.atEnd && !one.isMet ? ', last' : '') +
    (one.isMet && one.unmatched ? ', EVIDENCE NOT MATCHED' : '') +
    (isUnclear(one) ? ', CHECK UNCLEAR' : '') +
    (isYourCall(one) ? ", PERSON'S CALL" : '') +
    (!one.isMet && partsOf(list, one.id).length === 0 && !isFalsifiable(one.check) ? ', VAGUE CHECK' : '')
  const live = list.filter(one => isRequest(one) && isLive(one))
  const finished: string[] = []
  for (const request of live) {
    if (isDone(list, request)) {
      finished.push(request.id)
      continue
    }
    const parts = partsOf(list, request.id)
    const done = parts.filter(part => part.isMet).length
    lines.push(`${request.id}. [${parts.length > 0 ? `${done}/${parts.length}` : state(request)}] ${clip(request.ai, 70)}`)
    for (const part of parts.filter(one => !one.isMet)) lines.push(`  ${labelOf(list, part)}. [${state(part)}] ${clip(part.ai, 70)}`)
  }
  if (finished.length > 0) lines.push(`Done: ${finished.join(', ')}`)
  return lines.join('\n')
}

/** The full line of each item, as Claude reads changed items in detail. */
export function itemLines(list: readonly Intent[], items: readonly Intent[]): string {
  return items.map(one => line(list, one, false)).join('\n')
}

/**
 * The open goals worth putting beside a result, most relevant first: parts
 * being worked on, then the other open parts of their requests, then the
 * rest; at most `max`.
 */
export function relevantOpen(list: readonly Intent[], max: number): { shown: Intent[]; more: number } {
  const open = units(list).filter(one => !one.isMet)
  const active = open.filter(one => one.isActive)
  const sameRequest = open.filter(one => !one.isActive && active.some(a => a.parent && a.parent === one.parent))
  const rest = open.filter(one => !active.includes(one) && !sameRequest.includes(one))
  const ranked = [...active, ...sameRequest, ...rest]
  return { shown: ranked.slice(0, max), more: Math.max(0, ranked.length - max) }
}

/** Words that name nothing in particular: a line made only of these names no item. */
const GENERIC = new Set(
  'test tests testing pass passed passes passing fail failed failure failures ok okay all done check checks build built run runs ran suite total error errors success successful the and with for of in to it is works working work fine correct correctly properly good should must be as expected verify verified'.split(' '),
)

/** CJK words that name nothing in particular. */
const GENERIC_CJK = ['對應', '相關', '測試', '通過', '檢查', '正常', '完成', '成功', '可以', '沒有', '問題', '全部', '結果', '確認', '運作', '功能', '應該']

/**
 * Whether a check could come out wrong: it names something particular to
 * look at (a test, command, file or behaviour), not just "tests pass".
 */
export function isFalsifiable(check: string): boolean {
  let rest = check.toLowerCase()
  for (const word of GENERIC_CJK) rest = rest.split(word).join(' ')
  const words = rest.split(/[^a-z0-9_.\u3400-\u9fff-]+/).filter(w => w && !GENERIC.has(w))
  return weight(words.join('')) >= 4
}

/** The observer read this item's current check and found no result could prove it. */
export function isUnclear(one: Intent): boolean {
  return !one.isMet && one.checkKind === 'none' && one.checkJudged === one.check
}

/** The observer read this item's current check as one only the person's answer can settle. */
export function isYourCall(one: Intent): boolean {
  return !one.isMet && one.checkKind === 'person' && one.checkJudged === one.check
}

/**
 * Whether a line names the item: shares a distinctive word with it (an
 * identifier or word of four or more letters that is not generic, or a run
 * of two or more CJK characters).
 */
export function mentions(line: string, about: string): boolean {
  const said = normalize(line)
  const latin = (about.toLowerCase().match(/[a-z][a-z0-9_.-]{3,}/g) ?? []).filter(w => !GENERIC.has(w))
  if (latin.some(w => said.includes(w))) return true
  const cjk = about.match(/[\u3400-\u9fff]{2,}/g) ?? []
  return cjk.some(run => {
    for (let n = 0; n + 2 <= run.length; n += 1) if (said.includes(run.slice(n, n + 2)) && !['測試', '通過', '檢查', '對應'].includes(run.slice(n, n + 2))) return true
    return false
  })
}

/**
 * What must be done before an item checked last may be ticked: the other
 * open parts of its request, or, for a request, every other open goal on
 * the list (other last checks aside).
 */
export function blockersOf(list: readonly Intent[], one: Intent): Intent[] {
  if (!one.atEnd) return []
  const open = units(list).filter(x => x.id !== one.id && !x.isMet && !x.atEnd)
  return one.parent ? open.filter(x => x.parent === one.parent) : open.filter(x => x.parent !== one.id)
}
