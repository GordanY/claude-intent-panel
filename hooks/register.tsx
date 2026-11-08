import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Drift, Intent, Purpose } from '../types'

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

const START_PROMPT =
  '（目標面板）請依目前為止的對話，整理這次工作的原意和目標：' +
  `用 ${TOOL('intent_add')} 設定一行白話的原意，和 1～5 個我真正想要的目標（每個附具體的檢查方式）；` +
  `對話裡已經確實跑過、也通過檢查的目標，再用 ${TOOL('intent_met')} 補上依據打勾。` +
  '只根據對話裡真的發生過的事；如果對話還看不出要做什麼，就直接問我。整理完用一兩句話告訴我。'

const REFRESH_PROMPT =
  '（目標面板）請依目前的對話，重新整理目標面板裡的 AI 內容：原意和每個目標的白話摘要、檢查方式、打勾狀態。' +
  `用 ${TOOL('intent_revise')} 更新（原意用它的 purpose 欄位）；檢查其實沒有通過的目標用 reopen 取消打勾，確實通過但還沒勾的用 ${TOOL('intent_met')} 補上依據。` +
  '不要改動我自己寫的字；我的字跟你的摘要不一致時，以我的字為準。整理完用一兩句話告訴我改了什麼。'

type Saved = { purpose: Purpose; intents: Intent[]; drift: Drift | null }

const INSTRUCTIONS = `# Intent pane (intent-tracker mod)
A pane beside the chat shows the person, in plain Traditional Chinese, what the work in this worktree is for and which goals are met, so they do not get lost when the conversation turns technical. The list is kept per worktree across sessions. Keep it accurate and quiet (do not narrate these calls):
- When the person states the task, or the task changes, call ${TOOL('intent_add')} with a one-line \`purpose\` and the goals. Each goal: \`summary\` is one plain Traditional Chinese sentence a non-programmer understands (no file names, SHAs, flags or jargon); \`check\` is the concrete step that proves it (a test that passes, a behaviour observed, a diff condition), Traditional Chinese, identifiers allowed. Goals are outcomes the person wants, not your sub-steps: usually 1-5. Do not re-add goals already on the list.
- Call ${TOOL('intent_met')} only after a goal's check has actually been run or observed and passed, with the evidence. Never on intent, partial work or an unrun check. If later work breaks a met goal, call ${TOOL('intent_revise')} with reopen: true.
- The person may type their own words for the purpose or a goal; they reach you as context beside their prompt. Their words are the authority: when your summary or check diverges from them, revise yours to match, never the reverse.`

const toolSpecs = [
  {
    name: 'intent_add',
    description:
      'Add goals to the intent pane (and optionally set the purpose). Use when the person states a task or the task changes.',
    inputSchema: {
      type: 'object',
      properties: {
        purpose: {
          type: 'string',
          description: 'One plain Traditional Chinese line: what this work is for. Omit to keep the current one.',
        },
        intents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              summary: { type: 'string', description: 'Plain Traditional Chinese sentence, no jargon.' },
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
          description: 'Short Traditional Chinese note of what was run or observed (test name, behaviour seen).',
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
        purpose: { type: 'string', description: 'New plain Traditional Chinese purpose line.' },
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

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asSaved(value: unknown): Saved | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Partial<Saved>
  if (!Array.isArray(v.intents) || typeof v.purpose !== 'object' || v.purpose === null) return null
  return { purpose: v.purpose, intents: v.intents, drift: v.drift ?? null }
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
  const title = list.length === 0 ? '🎯 本次目標' : `🎯 本次目標 ${met}/${list.length}`
  await $.ui.open({ id: PANE, title })
}

/** Loads the worktree's list when the session's root is not the one loaded. */
async function sync($: EngineInterface): Promise<void> {
  const root = await $.session.root()
  const prev = await read($, loadedRoot)
  if (prev === root) return
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
  const data: Saved = {
    purpose: await read($, purpose),
    intents: [...(await read($, intents))],
    drift: await read($, drift),
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
    model: 'haiku',
    maxTokens: 200,
    system:
      "You check whether an AI coding assistant's latest turn stayed on the goals a person set for this work. Reply with JSON only.",
    prompt:
      `${listText(p, list)}\n\nThe person's latest message:\n${ask}\n\nWhat the assistant did this turn:\n${work.join('\n').slice(0, 8000)}\n\n` +
      'Work that serves any goal counts as on track: investigation, setup, verification, fixing what blocks a goal, and answering a direct question about the goals. ' +
      'Flag only work clearly unrelated to every goal and to the purpose.\n' +
      'Reply {"onTrack": true} or {"onTrack": false, "byUser": <true if the person\'s latest message itself asked for that off-list work>, ' +
      '"note": "<one short plain Traditional Chinese sentence naming the off-list work, no jargon>"}',
  })
  if (!answer.isAnswered) return

  const verdict = parseVerdict(answer.text)
  if (!verdict || verdict.isOnTrack || !verdict.note) return
  await update($, drift, () => ({ note: verdict.note, isByUser: verdict.isByUser }))
  await save($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const spec of toolSpecs) await $.tool.register(spec)
    await $.command.register({ name: 'intents', description: '打開本次目標面板' })
    await sweep($).catch(() => undefined)
    await sync($)

    return next(e)
  })

  on('command.run', { command: 'intents' }, async $ => {
    await sync($)
    await refreshTitle($, true)

    return { text: '已打開本次目標面板。' }
  })

  // Closed by the person: list changes stop reopening it until they ask again.
  // (This mod never closes its own pane, so any close but an unload is theirs.)
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind !== 'unload') await update($, isClosedByPerson, () => true)

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return {
      sections: [...composed.sections, { id: `${P}:instructions`, text: INSTRUCTIONS, scope: 'session' as const }],
    }
  })

  // The list reaches the model beside the next prompt after the person edits
  // their words, or when it was carried over from an earlier session.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
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

  on('tool.call', { tool: 'mcp__intent-tracker__intent_met' }, async ($, e) => {
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
    if (!e.agentId && e.reason === 'answer') {
      $.clock.after(0, () => {
        void checkDrift($).catch(() => undefined)
      })
    }

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const list = await read($, intents)
    const p = await read($, purpose)
    const off = await read($, drift)
    const edit = await read($, editing)
    const met = list.filter(one => one.isMet).length

    const saveMine = (target: string) => (value: string) => {
      void (async () => {
        const text = value.trim()
        if (target === 'purpose') await update($, purpose, old => ({ ...old, mine: text }))
        else await update($, intents, l => l.map(one => (one.id === target ? { ...one, mine: text } : one)))
        await update($, editing, () => null)
        await update($, isDirty, () => true)
        await save($)
      })()
    }

    const mineRow = (target: string, mine: string) =>
      mine && edit !== target ? (
        <Box flexDirection="row" gap={1}>
          <Text wrap="wrap">你：{mine}</Text>
          <Button key={`edit-${target}`} label="改" plain onPress={() => update($, editing, () => target)} />
        </Box>
      ) : (
        <Input
          key={`mine-${target}`}
          label="你："
          placeholder="用你自己的話寫，Enter 儲存"
          value={mine}
          submitLabel="儲存"
          onSubmit={saveMine(target)}
        />
      )

    if (list.length === 0 && !p.ai) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor wrap="wrap">還沒有目標。開始描述這次要做的事，Claude 會在這裡整理出來。</Text>
          <Text dimColor wrap="wrap">對話已經進行一段了？按「開始整理」，Claude 會依目前的對話整理出原意和目標。</Text>
          <Box flexDirection="row">
            <Button
              key="start"
              label="開始整理"
              onPress={async () => {
                await $.prompt.submit({ text: START_PROMPT })
                $.ui.toast('已請 Claude 依目前的對話整理原意和目標')
              }}
            />
          </Box>
        </Box>
      )
    }

    const clearRow =
      edit === 'confirm-clear' ? (
        <Box flexDirection="row" gap={1}>
          <Text color="red">確定清空這個 worktree 的清單？</Text>
          <Button
            key="clear-yes"
            label="清空"
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
          <Button key="clear-no" label="取消" onPress={() => update($, editing, () => null)} />
        </Box>
      ) : (
        <Box flexDirection="row" gap={2}>
          <Button
            key="refresh-ai"
            label="重新整理 AI 內容"
            plain
            onPress={async () => {
              // A turn of its own once the session is idle; the model may change
              // only the AI side (purpose, summaries, checks, ticks).
              await $.prompt.submit({ text: REFRESH_PROMPT })
              $.ui.toast('已請 Claude 重新整理 AI 內容（你寫的字不會動）')
            }}
          />
          <Button key="clear" label="清空清單" plain dimColor onPress={() => update($, editing, () => 'confirm-clear')} />
        </Box>
      )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>原意</Text>
          <Text wrap="wrap">AI：{p.ai || '（尚未整理）'}</Text>
          {mineRow('purpose', p.mine)}
        </Box>

        <Text bold>
          已達成 {met}/{list.length}
        </Text>

        {list.map(one => (
          <Box key={`goal-${one.id}`} flexDirection="column">
            <Text color={one.isMet ? 'green' : undefined} bold wrap="wrap">
              {one.isMet ? '✓' : '○'} {one.id}. {one.ai}
            </Text>
            {mineRow(one.id, one.mine)}
            <Text dimColor wrap="wrap">
              {one.isMet ? `依據：${one.evidence}` : `檢查：${one.check || '（未定）'}`}
            </Text>
          </Box>
        ))}

        {off && (
          <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
            <Text color="yellow" wrap="wrap">
              ⚠️ 偏題{off.isByUser ? '（你要求的）' : ''}：{off.note}
            </Text>
            <Box flexDirection="row" gap={1}>
              <Button
                key="drift-add"
                label="加入清單"
                onPress={async () => {
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
                label="忽略"
                onPress={async () => {
                  await update($, drift, () => null)
                  await save($)
                }}
              />
            </Box>
          </Box>
        )}

        {clearRow}
      </Box>
    )
  })
}
