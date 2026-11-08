import { expect, mock, test } from 'claude-code/testing'
import type { Intent } from '../types'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'intent-tracker',
  component: 'Pane',
  requestId: 'intents',
  props: {
    title: '本次目標',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const ROOT = '/repo/.claude/worktrees/fix-drafts'
const ADD = 'mcp__intent-tracker__intent_add'
const MET = 'mcp__intent-tracker__intent_met'

const SAVED = {
  purpose: { ai: '修好草稿消失的問題', mine: '' },
  intents: [
    { id: '1', ai: '關掉 app 後草稿要保留', mine: '草稿絕對不能不見', check: 'DraftPersistTests 通過', isMet: true, evidence: '3/3 通過' },
  ],
  drift: null,
}

/** Panes the engine holds open, and how many times the mod opened one. */
const ui = {
  up: new Set<string>(),
  opens: 0,
  registered: 0,
  clock: null as unknown as ReturnType<typeof mock.clock>,
  messages: [] as unknown[],
  /** Files that exist, by path: their last-modified time. */
  files: {} as Record<string, number>,
  /** What Claude Code reports as this session's agents. */
  agents: [] as { id: string; description: string; type: string; status: string }[],
}

/** What the person asked at the start of every test conversation: the words the seeded requests quote. */
const ASK = { role: 'user', text: '修好草稿消失的問題：關掉 app 後草稿要保留，不要動到同步。再多一個目標；桌面版也能用，面板出現', toolUses: [] }

/** The conversation a test runs on: the opening ask, then the test's own messages. */
function setMessages(make: () => { value: unknown[] }) {
  ui.messages = [ASK, ...make().value]
}

/** The engine beneath the mod; `dirs` are the folders that exist. */
function engine(
  on: On,
  initial: Record<string, unknown> = {},
  dirs: string[] = [ROOT, '/repo/.claude/worktrees'],
  lang: unknown = { code: 'zh' },
) {
  const store = new Map<string, unknown>(Object.entries(initial))
  if (lang !== null) store.set('settings:lang', lang)
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  ui.registered = 0
  ui.messages = [ASK]
  on('session.messages', () => ({ value: ui.messages }) as never)
  on('tool.register', () => {
    ui.registered += 1
    return { value: {} }
  })
  on('command.register', () => ({ value: { command: 'intents' } }))
  ui.up.clear()
  ui.opens = 0
  ui.clock = mock.clock(on, { now: 1_700_000_000_000 })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('ui.open', (_, e) => {
    ui.up.add(e.id)
    ui.opens += 1
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    ui.up.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...ui.up].map(id => ({ id, title: '', isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  ui.files = {}
  ui.agents = []
  on('agent.list', () => ({ value: ui.agents }) as never)
  on('fs.stat', (_, e) => {
    const mtime = ui.files[e.path]
    if (mtime !== undefined) return { value: { kind: 'file', size: 1, mtimeMs: mtime, isLink: false } }
    if (!dirs.includes(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
  })
  return store
}

async function start($: Parameters<Parameters<typeof test>[1]>[0]) {
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
}

async function seed($: Parameters<Parameters<typeof test>[1]>[0]) {
  await start($)
  await $.tool.call({
    tool: ADD,
    purpose: '修好草稿消失的問題',
    intents: [
      { summary: '關掉 app 後草稿要保留', check: 'DraftPersistTests 通過', source: '關掉 app 後草稿要保留' },
      { summary: '不要動到同步', check: 'diff 不含 Sync/', source: '不要動到同步' },
    ],
  } as never)
}

test('goals show in the pane, tick once their check passes, and are saved for the worktree', async ($, on) => {
  const store = engine(on)
  await seed($)

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /[▓░]/ }))?.text?.endsWith(' 0/2')).toBe(true)
  expect((await ui.find({ type: 'Text', text: /草稿要保留/ }))?.text).toBe('○ 1. 關掉 app 後草稿要保留')
  expect((await ui.find({ type: 'Text', text: /檢查：DraftPersist/ }))?.text).toBe('  檢查：DraftPersistTests 通過')
  // No field for the person's words until they press ✎.
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  await ui.unmount()

  const refused = await $.tool.call({ tool: MET, id: '1', evidence: '' } as never)
  expect('deny' in refused && typeof refused.deny === 'string').toBe(true)

  await $.tool.call({ tool: MET, id: '1', evidence: 'DraftPersistTests 3/3 通過' } as never)
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The desktop draws the bar (block characters would wrap there), the count beside it.
  expect(await ui.find({ type: 'Text', text: /[▓░]/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^1\/2$/ }))?.text).toBe('1/2')
  // Done goals fold to one line until opened.
  expect(await ui.find({ type: 'Text', text: /草稿要保留/ })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'done-toggle' }))?.text).toBe('✓ 已完成 1 項 ▸')
  await ui.press({ key: 'done-toggle' })
  expect((await ui.find({ type: 'Text', text: /草稿要保留/ }))?.text).toBe('✓ 1. 關掉 app 後草稿要保留')
  // The evidence is not listed under each done item; ⋯ shows it on demand.
  expect(await ui.find({ type: 'Text', text: /依據/ })).toBeUndefined()
  await ui.press({ key: 'details-1' })
  expect((await ui.find({ type: 'Text', text: /依據/ }))?.text).toBe('  依據：DraftPersistTests 3/3 通過')
  await ui.unmount()

  const saved = (store.get(`wt:${ROOT}`)) as typeof SAVED
  expect(saved.intents.length).toBe(2)
  expect(saved.intents[0]?.isMet).toBe(true)
})

test("the person's own words show and reach the model once", async ($, on) => {
  const store = engine(on)
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  await seed($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'edit-1' })
  await ui.input({ key: 'mine-1', text: '草稿絕對不能不見' })
  expect((await ui.find({ type: 'Text', text: /你：草稿/ }))?.text).toBe('  你：草稿絕對不能不見')
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  await ui.unmount()

  const first = await $.prompt.submit({ text: '繼續' })
  expect('context' in first && first.context?.some(c => c.includes('草稿絕對不能不見'))).toBe(true)
  const second = await $.prompt.submit({ text: '再繼續' })
  // The list rides once; every message carries only the short "record it first" reminder.
  expect('context' in second && (second.context ?? []).some(c => c.includes('草稿絕對不能不見'))).toBe(false)
  expect('context' in second && (second.context ?? []).length).toBe(1)
})

test('a resumed session shows the list saved for its worktree and tells the model', async ($, on) => {
  const store = engine(on, { [`wt:${ROOT}`]: SAVED })
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /[▓░]/ }))?.text?.endsWith(' 1/1')).toBe(true)
  await ui.press({ key: 'done-toggle' })
  expect((await ui.find({ type: 'Text', text: /草稿絕對不能不見/ }))?.text).toBe('✓ 1. 草稿絕對不能不見')
  await ui.unmount()

  const first = await $.prompt.submit({ text: '繼續昨天的' })
  expect('context' in first && first.context?.some(c => c.includes('修好草稿消失的問題'))).toBe(true)
})

test("a removed worktree's list is deleted; one on an unmounted disk is kept", async ($, on) => {
  const store = engine(on, {
    [`wt:${ROOT}`]: SAVED,
    'wt:/repo/.claude/worktrees/old-task': SAVED,
    'wt:/Volumes/Dev/worktrees/other': SAVED,
  })
  await start($)

  expect(store.get('wt:/repo/.claude/worktrees/old-task')).toBeUndefined()
  expect(store.get('wt:/Volumes/Dev/worktrees/other')).toBeDefined()
  expect(store.get(`wt:${ROOT}`)).toBeDefined()
})

test('clearing takes two presses and removes the saved list', async ($, on) => {
  const store = engine(on)
  await seed($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'clear' })
  expect(store.get(`wt:${ROOT}`)).toBeDefined()
  await ui.press({ key: 'clear-yes' })
  await ui.unmount()

  expect(store.get(`wt:${ROOT}`)).toBeUndefined()
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await after.find({ type: 'Text', text: /還沒有目標/ }))?.text).toBe('還沒有目標。')
  await after.unmount()
})

test('an off-list turn raises a drift warning that can be added to the list', async ($, on) => {
  const store = engine(on)
  const clock = ui.clock
  setMessages(() => ({
    value: [
      { role: 'user', text: '幫我修草稿', toolUses: [] },
      {
        role: 'assistant',
        text: '我順便改了 CI timeout',
        toolUses: [{ tool_use_id: 't1', tool: 'Edit', input: { file_path: '.github/workflows/ci.yml' } }],
      },
    ],
  }))
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: '{"onTrack": false, "byUser": false, "note": "改了 CI 的等待時間"}',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }))
  on('turn.complete', () => ({ text: 'done' }))
  await seed($)

  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.settle()

  let view = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await view.find({ type: 'Text', text: /⚠️ 偏題/ }))?.text).toBe('⚠️ 偏題：改了 CI 的等待時間')
  await view.press({ key: 'drift-add' })
  await view.unmount()

  view = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await view.find({ type: 'Text', text: /⚠️ 偏題/ })).toBeUndefined()
  expect((await view.find({ type: 'Text', text: /[▓░]/ }))?.text?.endsWith(' 0/3')).toBe(true)
  await view.unmount()
})

test('a pane the person closed is not reopened by list changes, only by /intents', async ($, on) => {
  engine(on)
  // The mod's ui.close hook sets this value when the person closes the pane;
  // the kit raises no ui.close of its own, so the test stands in for it.
  let closedByPerson = false
  on('state.get', { plugin: 'intent-tracker', key: 'isClosedByPerson' } as never, (_, e, next) =>
    closedByPerson ? { value: { value: true, version: 1 } } : next(e),
  )
  await seed($)

  ui.up.delete('intents')
  closedByPerson = true
  const before = ui.opens
  await $.tool.call({ tool: MET, id: '1', evidence: '測試通過' } as never)
  await $.tool.call({ tool: ADD, intents: [{ summary: '多一個目標', check: '看得到', source: '多一個目標' }] } as never)
  expect(ui.opens).toBe(before)
  expect(ui.up.has('intents')).toBe(false)

  closedByPerson = false
  await $.command.run({ command: 'intents', args: '' } as never)
  expect(ui.up.has('intents')).toBe(true)
  await $.tool.call({ tool: MET, id: '2', evidence: '看到了' } as never)
  expect(ui.opens).toBe(before + 2)
})

test("the refresh button asks Claude to redo the AI side only, and the person's words stay", async ($, on) => {
  const store = engine(on)
  const submitted: string[] = []
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text, context: e.context }
  })
  await seed($)

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'edit-1' })
  await pane.input({ key: 'mine-1', text: '草稿絕對不能不見' })

  await pane.press({ key: 'refresh-ai' })
  await pane.unmount()
  expect(submitted.some(t => t.includes('重新整理目標面板裡的 AI 內容') && t.includes('不要改動我自己寫的字'))).toBe(true)
  // Claude reads the list with the read-only tool, never by provoking an error.
  expect(submitted.some(t => t.includes('mcp__intent-tracker__intent_list'))).toBe(true)

  // What the model does with it: revise the purpose and a goal's summary.
  await $.tool.call({ tool: 'mcp__intent-tracker__intent_revise', purpose: '讓草稿永遠不會消失' } as never)
  await $.tool.call({ tool: 'mcp__intent-tracker__intent_revise', id: '1', summary: '關掉再打開 app，草稿都還在' } as never)
  const saved = store.get(`wt:${ROOT}`) as typeof SAVED
  expect(saved.purpose.ai).toBe('讓草稿永遠不會消失')
  expect(saved.intents[0]?.ai).toBe('關掉再打開 app，草稿都還在')
  expect(saved.intents[0]?.mine).toBe('草稿絕對不能不見')

  const refused = await $.tool.call({ tool: 'mcp__intent-tracker__intent_revise' } as never)
  expect('deny' in refused && typeof refused.deny === 'string').toBe(true)
})

test('an empty pane offers a start button that asks Claude to build the list from the conversation', async ($, on) => {
  engine(on)
  const submitted: string[] = []
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text, context: e.context }
  })
  await start($)

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Button', key: 'start' })).toBeDefined()
  await pane.press({ key: 'start' })
  await pane.unmount()
  expect(submitted.some(t => t.includes('請依目前為止的對話') && t.includes('mcp__intent-tracker__intent_add'))).toBe(true)

  await seed($)
  const filled = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await filled.find({ type: 'Button', key: 'start' })).toBeUndefined()
  await filled.unmount()
})

test('the bottom toolbar shows icon + text when wide and icon alone when narrow', async ($, on) => {
  engine(on)
  await seed($)

  const wide = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 60 }, surface: 'terminal' })
  expect((await wide.find({ type: 'Button', key: 'refresh-ai' }))?.text).toBe('↻ 重新整理 AI 內容')
  expect((await wide.find({ type: 'Button', key: 'clear' }))?.text).toBe('⌫ 清空清單')
  expect((await wide.find({ type: 'Button', key: 'close' }))?.text).toBe('✕ 關閉')
  await wide.unmount()

  const narrow = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 20 }, surface: 'terminal' })
  expect((await narrow.find({ type: 'Button', key: 'refresh-ai' }))?.text).toBe('↻')
  expect((await narrow.find({ type: 'Button', key: 'clear' }))?.text).toBe('⌫')
  expect((await narrow.find({ type: 'Button', key: 'close' }))?.text).toBe('✕')
  await narrow.unmount()
})

test('intent_list reads the list without changing it or raising an error', async ($, on) => {
  const store = engine(on)
  await seed($)
  const before = JSON.stringify(store.get(`wt:${ROOT}`))

  const listed = await $.tool.call({ tool: 'mcp__intent-tracker__intent_list' } as never)
  expect('deny' in listed && listed.deny !== undefined).toBe(false)
  expect(JSON.stringify(listed)).toContain('關掉 app 後草稿要保留')
  expect(JSON.stringify(store.get(`wt:${ROOT}`))).toBe(before)
})

test('the footer shows when the list last changed and which models do the work', async ($, on) => {
  engine(on)
  await seed($)

  let pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /Opus/ }))?.text).toBe('剛剛 · 整理 Opus 5.5 · 偏題 ')
  expect((await pane.find({ type: 'Button', key: 'drift-model' }))?.text).toBe('Haiku')
  expect((await pane.find({ type: 'Button', key: 'lang' }))?.text).toBe('🌐 中文')
  expect((await pane.find({ type: 'Text', text: /^─+$/ }))).toBeDefined()
  await pane.unmount()

  await ui.clock.advance(10 * 60_000)
  pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /Opus/ }))?.text).toBe('10 分鐘前 · 整理 Opus 5.5 · 偏題 ')
  await pane.unmount()

  await $.tool.call({ tool: MET, id: '1', evidence: '通過' } as never)
  pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /Opus/ }))?.text).toBe('剛剛 · 整理 Opus 5.5 · 偏題 ')
  await pane.unmount()
})

test('the bottom close button closes the pane and keeps it closed until /intents', async ($, on) => {
  engine(on)
  await seed($)
  expect(ui.up.has('intents')).toBe(true)

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'close' })
  await pane.unmount()
  expect(ui.up.has('intents')).toBe(false)

  const before = ui.opens
  await $.tool.call({ tool: MET, id: '1', evidence: '通過' } as never)
  expect(ui.opens).toBe(before)
  expect(ui.up.has('intents')).toBe(false)

  await $.command.run({ command: 'intents', args: '' } as never)
  expect(ui.up.has('intents')).toBe(true)
})

test('the language defaults to English and the choice is saved and applied', async ($, on) => {
  const store = engine(on, {}, undefined, null)
  on('prompt.compose', () => ({ sections: [] }))
  await seed($)

  let pane = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 60 }, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /Opus/ }))?.text).toBe('just now · goals Opus 5.5 · drift ')
  expect((await pane.find({ type: 'Button', key: 'refresh-ai' }))?.text).toBe('↻ Refresh AI content')
  expect((await pane.find({ type: 'Button', key: 'lang' }))?.text).toBe('🌐 English')

  await pane.press({ key: 'lang' })
  await pane.press({ key: 'lang-ja' })
  await pane.unmount()
  expect(store.get('settings:lang')).toEqual({ code: 'ja' })

  pane = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 60 }, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /Opus/ }))?.text).toBe('たった今 · 整理 Opus 5.5 · 脱線 ')
  expect((await pane.find({ type: 'Button', key: 'lang' }))?.text).toBe('🌐 日本語')
  await pane.press({ key: 'lang' })
  await pane.press({ key: 'lang-custom' })
  await pane.input({ key: 'lang-custom-input', text: 'Deutsch' })
  await pane.unmount()
  expect(store.get('settings:lang')).toEqual({ code: 'custom', custom: 'Deutsch' })

  // A custom language: English labels, Claude told to write in it.
  pane = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 60 }, surface: 'terminal' })
  expect((await pane.find({ type: 'Button', key: 'lang' }))?.text).toBe('🌐 Deutsch')
  await pane.unmount()
  const composed = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits: [],
  } as never)
  expect(JSON.stringify(composed)).toContain('plain Deutsch sentence')
})

test('a saved language choice is read back by a new session', async ($, on) => {
  engine(on, {}, undefined, { code: 'ja' })
  const submitted: string[] = []
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text, context: e.context }
  })
  await start($)

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /まだ目標がありません/ }))).toBeDefined()
  await pane.press({ key: 'start' })
  await pane.unmount()
  expect(submitted.some(t => t.startsWith('（目標パネル）') && t.includes('日本語'))).toBe(true)
})

const COMPOSE = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['terminal'],
  tools: [],
  outputStyle: null,
  traits: [],
}

test('a headless session (-p, SDK) gets no tools, no instructions, no drift check', async ($, on) => {
  const store = engine(on)
  let modelCalls = 0
  on('model.complete', () => {
    modelCalls += 1
    return { value: { isAnswered: true, text: '{"onTrack": true}', usage: {} } }
  })
  on('prompt.compose', () => ({ sections: [] }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('turn.complete', () => ({ text: 'done' }))
  setMessages(() => ({ value: [{ role: 'user', text: '做事', toolUses: [] }, { role: 'assistant', text: '好', toolUses: [] }] }))
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: false } as never)

  expect(ui.registered).toBe(0)
  expect(ui.up.has('intents')).toBe(false)
  const composed = await $.prompt.compose({ ...COMPOSE, surfaces: [], traits: ['print'] } as never)
  expect(JSON.stringify(composed)).not.toContain('Intent pane')
  const submitted = await $.prompt.submit({ text: 'run the task' })
  expect('context' in submitted && (submitted.context ?? []).length).toBe(0)
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await ui.clock.settle()
  expect(modelCalls).toBe(0)
  expect(store.has(`wt:${ROOT}`)).toBe(false)
})

test('an interactive session gets the instructions; a teammate prompt or one with no surface does not', async ($, on) => {
  engine(on)
  on('prompt.compose', () => ({ sections: [] }))
  await start($)

  expect(ui.registered).toBe(4)
  expect(JSON.stringify(await $.prompt.compose(COMPOSE as never))).toContain('Intent pane')
  expect(JSON.stringify(await $.prompt.compose({ ...COMPOSE, traits: ['teammate'] } as never))).not.toContain('Intent pane')
  expect(JSON.stringify(await $.prompt.compose({ ...COMPOSE, surfaces: [] } as never))).not.toContain('Intent pane')
})

test("a subagent cannot change the main conversation's list", async ($, on) => {
  const store = engine(on)
  await seed($)
  const before = JSON.stringify(store.get(`wt:${ROOT}`))

  for (const call of [
    { tool: ADD, agentId: 'sub-1', intents: [{ summary: '子任務', check: '看到' }] },
    { tool: MET, agentId: 'sub-1', id: '1', evidence: '我說過了' },
    { tool: 'mcp__intent-tracker__intent_revise', agentId: 'sub-1', id: '1', summary: '改掉' },
  ]) {
    const result = await $.tool.call(call as never)
    expect('deny' in result && typeof result.deny === 'string').toBe(true)
  }
  expect(JSON.stringify(store.get(`wt:${ROOT}`))).toBe(before)
})

test("the purpose is one line: the person's words lead, Claude's line under them", async ($, on) => {
  engine(on)
  await seed($)

  let pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /修好草稿/ }))?.text).toBe('修好草稿消失的問題')
  await pane.press({ key: 'edit-purpose' })
  await pane.input({ key: 'mine-purpose', text: '草稿不能再不見' })
  await pane.unmount()

  pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /草稿不能再不見/ }))?.text).toBe('草稿不能再不見')
  expect((await pane.find({ type: 'Text', text: /AI：/ }))?.text).toBe('AI：修好草稿消失的問題')
  await pane.unmount()
})

test('a drift warning sits above the goals, where it is seen first', async ($, on) => {
  engine(on, {
    [`wt:${ROOT}`]: { ...SAVED, intents: [{ ...SAVED.intents[0], isMet: false }], drift: { note: '改了 CI', isByUser: false } },
  })
  await start($)

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const texts = (await pane.findAll({ type: 'Text' })).map(one => one.text)
  const driftAt = texts.findIndex(one => one.startsWith('⚠️'))
  const goalAt = texts.findIndex(one => one.startsWith('○ 1.'))
  expect(driftAt >= 0 && goalAt > driftAt).toBe(true)
  await pane.unmount()
})

test('a change another session saves for this worktree shows here and reaches the model', async ($, on) => {
  const store = engine(on)
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  await seed($)
  await $.prompt.submit({ text: '開始' })

  // The other session (a terminal beside the desktop app) ticks goal 1 and adds its own words.
  const shared = store.get(`wt:${ROOT}`) as typeof SAVED & { updatedAt: number }
  store.set(`wt:${ROOT}`, {
    ...shared,
    intents: shared.intents.map(one => (one.id === '1' ? { ...one, isMet: true, evidence: '在終端機跑過 3/3', mine: '草稿要在' } : one)),
    updatedAt: shared.updatedAt + 1,
  })
  await ui.clock.advance(2_000)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /^1\/2$/ }))?.text).toBe('1/2')
  await pane.unmount()

  const next = await $.prompt.submit({ text: '繼續' })
  expect('context' in next && next.context?.some(c => c.includes('在終端機跑過 3/3'))).toBe(true)
})

test("a change made here builds on the other session's newer copy, never over it", async ($, on) => {
  const store = engine(on)
  await seed($)

  // Before this session's timer fires, the other session adds a goal.
  const shared = store.get(`wt:${ROOT}`) as typeof SAVED & { updatedAt: number }
  store.set(`wt:${ROOT}`, {
    ...shared,
    intents: [...shared.intents, { id: '3', ai: '別的 session 加的', mine: '', check: '看得到', isMet: false, evidence: '' }],
    updatedAt: shared.updatedAt + 1,
  })
  await $.tool.call({ tool: MET, id: '2', evidence: 'diff 不含 Sync/' } as never)

  const saved = store.get(`wt:${ROOT}`) as typeof SAVED
  expect(saved.intents.length).toBe(3)
  expect(saved.intents.find(one => one.id === '2')?.isMet).toBe(true)
  expect(saved.intents.find(one => one.id === '3')?.ai).toBe('別的 session 加的')
})

test('a list another session cleared is cleared here too', async ($, on) => {
  const store = engine(on)
  await seed($)
  store.delete(`wt:${ROOT}`)
  await ui.clock.advance(2_000)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /還沒有目標/ }))?.text).toBe('還沒有目標。')
  await pane.unmount()
})

test('a language another session picks is applied here', async ($, on) => {
  const store = engine(on)
  await seed($)
  store.set('settings:lang', { code: 'en' })
  await ui.clock.advance(2_000)

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /Check/ }))?.text).toBe('  Check: DraftPersistTests 通過')
  await pane.unmount()
})

test('a desktop-app session (SDK-hosted, no surface at start) turns on when the desktop attaches', async ($, on) => {
  engine(on)
  on('session.surfaces', () => ({ value: [] }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: false })
  expect(ui.registered).toBe(0)

  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  expect(ui.registered).toBe(4)
  await $.tool.call({ tool: ADD, purpose: '桌面版也能用', intents: [{ summary: '面板出現', check: '看得到', source: '面板出現' }] } as never)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /面板出現/ }))?.text).toBe('○ 1. 面板出現')
  await pane.unmount()
})

test('the footer rule is box characters on the terminal and a 1px line on the desktop, never wrapping text', async ($, on) => {
  engine(on)
  await seed($)

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await term.find({ type: 'Text', text: /^─+$/ }))?.text?.length).toBe(50)
  await term.unmount()

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desk.find({ type: 'Text', text: /─/ })).toBeUndefined()
  expect(await desk.find({ type: 'Svg' })).toBeDefined()
  await desk.unmount()
})

test('the drift check model is picked in the footer, saved for every session, and used for the next check', async ($, on) => {
  const store = engine(on)
  const asked: string[] = []
  setMessages(() => ({
    value: [
      { role: 'user', text: '幫我修草稿', toolUses: [] },
      { role: 'assistant', text: '改了 CI', toolUses: [{ tool_use_id: 't1', tool: 'Edit', input: { file_path: 'ci.yml' } }] },
    ],
  }))
  on('model.complete', (_, e) => {
    asked.push(e.model)
    return { value: { isAnswered: true, text: '{"onTrack": true}', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  })
  on('turn.complete', () => ({ text: 'done' }))
  await seed($)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'drift-model' })
  expect((await pane.find({ type: 'Button', key: 'model-sonnet' }))?.text).toBe('Sonnet')
  await pane.press({ key: 'model-sonnet' })
  expect((await pane.find({ type: 'Button', key: 'drift-model' }))?.text).toBe('Sonnet')
  expect(await pane.find({ type: 'Button', key: 'model-opus' })).toBeUndefined()
  await pane.unmount()
  expect(store.get('settings:driftModel')).toBe('sonnet')

  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await ui.clock.settle()
  expect(asked).toEqual(['sonnet'])
})

test('a drift model another session picks is used here; an unknown saved value falls back to Haiku', async ($, on) => {
  const store = engine(on, { 'settings:driftModel': 'gpt-9' })
  await seed($)
  let pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Button', key: 'drift-model' }))?.text).toBe('Haiku')
  await pane.unmount()

  store.set('settings:driftModel', 'opus')
  await ui.clock.advance(2_000)
  pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Button', key: 'drift-model' }))?.text).toBe('Opus')
  await pane.unmount()
})

test('a finished test run or report carries the open goals; other calls and finished lists do not', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: 'ok' }) as never)
  await seed($)

  const notes = async (call: Record<string, unknown>) => {
    const done = await $.tool.call(call as never)
    return 'context' in done ? (done.context ?? []) : []
  }
  const ran = await notes({ tool: 'Bash', command: 'xcodebuild test -scheme App' })
  expect(ran.length).toBe(1)
  expect(ran[0]).toContain('<intent-pane>')
  expect(ran[0]).toContain('1. [open] 關掉 app 後草稿要保留 | check: DraftPersistTests 通過')
  expect(ran[0]).toContain('mcp__intent-tracker__intent_met')
  expect((await notes({ tool: 'Agent', prompt: 'review', description: 'review' })).length).toBe(1)

  // Not a result: a plain command, a call started in the background, a subagent's own call.
  expect((await notes({ tool: 'Bash', command: 'ls -la' })).length).toBe(0)
  expect((await notes({ tool: 'Bash', command: 'npm test', run_in_background: true })).length).toBe(0)
  expect((await notes({ tool: 'Agent', prompt: 'x', run_in_background: true })).length).toBe(0)
  expect((await notes({ tool: 'Bash', command: 'npm test', agentId: 'sub-1' })).length).toBe(0)

  // Every goal met (and confirmed): nothing to say.
  await $.tool.call({ tool: MET, id: '1', evidence: 'ok' } as never)
  await $.tool.call({ tool: MET, id: '2', evidence: 'ok' } as never)
  expect((await notes({ tool: 'Bash', command: 'npm test' })).length).toBe(0)
})

test("a background task's notification carries the open goals; other hidden prompts do not", async ($, on) => {
  engine(on)
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  await seed($)

  const notified = await $.prompt.submit({
    text: '<task-notification><status>completed</status><summary>tests passed</summary></task-notification>',
    isMeta: true,
  } as never)
  expect('context' in notified && notified.context?.some(c => c.includes('2. [open] 不要動到同步'))).toBe(true)
  const other = await $.prompt.submit({ text: 'some reminder', isMeta: true } as never)
  expect('context' in other && (other.context ?? []).length).toBe(0)
})

test("after a turn, a goal its output shows passing is ticked and counted at once, tagged as seen in output", async ($, on) => {
  const store = engine(on)
  let toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? e))
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('tool.call', () => ({ result: 'ok' }) as never)
  let asked = ''
  setMessages(() => ({
    value: [
      { role: 'user', text: '跑測試', toolUses: [] },
      {
        role: 'assistant',
        text: '跑完了',
        toolUses: [
          {
            tool_use_id: 't1',
            tool: 'Bash',
            input: { command: 'xcodebuild test -only-testing:DraftPersistTests' },
            text: 'Test Suite DraftPersistTests passed\nExecuted 3 tests, with 0 failures',
          },
        ],
      },
    ],
  }))
  on('model.complete', (_, e) => {
    asked = String((e as { prompt?: unknown }).prompt)
    return {
      value: {
        isAnswered: true,
        // "9" is no goal and "3" is unknown: both are dropped.
        text: '{"onTrack": true, "met": [{"id": "1", "evidence": "DraftPersistTests：3 個測試 0 失敗"}, {"id": "9", "evidence": "x"}]}',
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }
  })
  on('turn.complete', () => ({ text: 'done' }))
  await seed($)

  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await ui.clock.settle()

  // The check read the tool's output, not only its input.
  expect(asked).toContain('Executed 3 tests, with 0 failures')
  const saved = store.get(`wt:${ROOT}`) as { intents: { id: string; isMet: boolean; isAuto?: boolean; evidence: string }[] }
  expect(saved.intents[0]?.isMet).toBe(true)
  expect(saved.intents[0]?.isAuto).toBe(true)
  expect(saved.intents[0]?.evidence).toBe('DraftPersistTests：3 個測試 0 失敗')
  expect(saved.intents[1]?.isMet).toBe(false)
  expect(toasts.some(t => t.includes('觀察者：勾選目標 1'))).toBe(true)

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /[▓░]/ }))?.text?.endsWith(' 1/2')).toBe(true)
  expect((await pane.find({ type: 'Button', key: 'done-toggle' }))?.text).toBe('✓ 已完成 1 項（1 項從輸出看到） ▸')
  await pane.press({ key: 'done-toggle' })
  expect((await pane.find({ type: 'Text', text: /草稿要保留/ }))?.text).toBe('✓ 1. 關掉 app 後草稿要保留（從輸出看到）')
  await pane.unmount()

  // Claude reads the auto tick beside the next prompt and confirms it.
  const next = await $.prompt.submit({ text: '繼續' } as never)
  expect('context' in next && next.context?.some(c => c.includes('1. [request · goal · met (seen in output)]'))).toBe(true)
  await $.tool.call({ tool: MET, id: '1', evidence: '我看過輸出：3/3 通過' } as never)
  const confirmed = store.get(`wt:${ROOT}`) as typeof saved
  expect(confirmed.intents[0]?.isAuto).toBe(false)
  expect(confirmed.intents[0]?.evidence).toBe('我看過輸出：3/3 通過')
})

test('a list saved before auto ticks existed loads and draws as it did', async ($, on) => {
  engine(on, { [`wt:${ROOT}`]: SAVED })
  await start($)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Button', key: 'done-toggle' }))?.text).toBe('✓ 已完成 1 項 ▸')
  await pane.unmount()
})

const REVISE = 'mcp__intent-tracker__intent_revise'
/**
 * A tool beneath the mod that holds each call open until released, so a test
 * can look at the pane while the tool is still running.
 */
function heldTools(on: On, result: (e: Record<string, unknown>) => unknown = () => ({ result: 'ok' })) {
  let release: (() => void) | null = null
  on('tool.call', async (_, e) => {
    await new Promise<void>(r => (release = r))
    return result(e as unknown as Record<string, unknown>) as never
  })
  return async (start: () => Promise<unknown>, look: () => Promise<void>) => {
    release = null
    const call = start()
    for (let n = 0; n < 500 && !release; n += 1) await Promise.resolve()
    await look()
    ;(release as (() => void) | null)?.()
    await call
  }
}
const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

async function texts(pane: { findAll: (q: { type: string }) => Promise<{ text?: string }[]> }) {
  return (await pane.findAll({ type: 'Text' })).map(one => one.text ?? '')
}

test("a request must quote the person; Claude's own ideas and technical steps are refused", async ($, on) => {
  engine(on)
  await start($)

  const none = await $.tool.call({ tool: ADD, intents: [{ summary: '重構 NoteStore', check: 'build 過' }] } as never)
  expect('deny' in none && (none.deny ?? "").includes('a request needs source')).toBe(true)
  const invented = await $.tool.call({
    tool: ADD,
    intents: [{ summary: '加快載入', check: '量測', source: '順便把載入加快' }],
  } as never)
  expect('deny' in invented && (invented.deny ?? "").includes('never said')).toBe(true)
  // Loose matching: spacing and quote marks do not matter, an ellipsis joins two pieces.
  const quoted = await $.tool.call({
    tool: ADD,
    intents: [{ summary: '草稿要保留', check: '測試', source: '「關掉 app 後…不要動到同步」' }],
  } as never)
  expect('deny' in quoted).toBe(false)
})

test('a request breaks into parts; progress counts the parts and the request is done when all are', async ($, on) => {
  const store = engine(on)
  await start($)
  await $.tool.call({
    tool: ADD,
    purpose: '修好草稿',
    intents: [
      { summary: '草稿不再消失', check: '整體', source: '修好草稿消失的問題' },
      { summary: '關掉 app 後草稿還在', check: 'DraftPersistTests', parent: '+1' },
      { summary: '切換筆記本後草稿還在', check: 'SwitchTests', parent: '+1' },
    ],
  } as never)

  // A request with parts is ticked through its parts.
  const direct = await $.tool.call({ tool: MET, id: '1', evidence: '好了' } as never)
  expect('deny' in direct && (direct.deny ?? "").includes('has parts')).toBe(true)
  // A part never quotes; a part of a part is refused.
  const nested = await $.tool.call({ tool: ADD, intents: [{ summary: '更細', check: 'x', parent: '1a' }] } as never)
  expect('deny' in nested).toBe(true)

  await $.tool.call({ tool: MET, id: '1a', evidence: 'DraftPersistTests 3/3' } as never)
  let pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Finished parts fold under their request until ▸ opens them.
  expect((await texts(pane)).some(x => x.includes('1a. 關掉 app 後草稿還在'))).toBe(false)
  await pane.press({ key: 'fold-1' })
  let shown = await texts(pane)
  expect(shown.some(x => x.endsWith(' 1/2') && /[▓░]/.test(x))).toBe(true)
  expect(shown).toContain('◐ 1. 草稿不再消失 1/2')
  expect(shown).toContain('  ✓ 1a. 關掉 app 後草稿還在')
  expect(shown).toContain('  ○ 1b. 切換筆記本後草稿還在')
  await pane.unmount()

  await $.tool.call({ tool: MET, id: '1b', evidence: 'SwitchTests 2/2' } as never)
  pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Button', key: 'done-toggle' }))?.text).toBe('✓ 已完成 1 項 ▸')
  await pane.unmount()
  const saved = store.get(`wt:${ROOT}`) as { intents: { id: string; parent?: string; source?: string }[] }
  // Parts have their own ids: request numbers are not used up by them.
  expect(saved.intents.find(one => one.id === 'p1')?.parent).toBe('1')
  expect(saved.intents.find(one => one.id === '1')?.source).toBe('修好草稿消失的問題')
})

test('a limit sits apart, is never ticked or counted, and shows when broken', async ($, on) => {
  engine(on)
  await start($)
  await $.tool.call({
    tool: ADD,
    intents: [
      { summary: '草稿要保留', check: 'DraftPersistTests', source: '關掉 app 後草稿要保留' },
      { summary: '同步不受影響', check: 'diff 不含 Sync/', source: '不要動到同步', kind: 'limit' },
    ],
  } as never)
  const ticked = await $.tool.call({ tool: MET, id: '2', evidence: 'ok' } as never)
  expect('deny' in ticked && (ticked.deny ?? "").includes('limit')).toBe(true)

  let pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  let shown = await texts(pane)
  expect(shown.some(x => x.endsWith(' 0/1') && /[▓░]/.test(x))).toBe(true)
  expect(shown).toContain('過程中要遵守的限制')
  expect(shown).toContain('🛡 2. 同步不受影響')
  await pane.unmount()

  await $.tool.call({ tool: REVISE, id: '2', broken: 'diff 動到 Sync/Engine.swift' } as never)
  pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  shown = await texts(pane)
  expect(shown).toContain('✗ 2. 同步不受影響')
  expect(shown).toContain('  被破壞：diff 動到 Sync/Engine.swift')
  await pane.unmount()
})

test('a dropped request is cancelled only on the person\'s words, takes its parts along, and can be restored', async ($, on) => {
  const store = engine(on)
  await start($)
  await $.tool.call({
    tool: ADD,
    intents: [
      { summary: '草稿要保留', check: '整體', source: '關掉 app 後草稿要保留' },
      { summary: '關掉 app 後還在', check: 'DraftPersistTests', parent: '+1' },
      { summary: '桌面版也能用', check: '看得到', source: '桌面版也能用' },
    ],
  } as never)

  const unsaid = await $.tool.call({ tool: REVISE, id: '1', cancel: '算了不要' } as never)
  expect('deny' in unsaid && (unsaid.deny ?? "").includes('never said')).toBe(true)
  ui.messages = [...ui.messages, { role: 'user', text: '草稿那個算了不要，先做桌面版', toolUses: [] }]
  await $.tool.call({ tool: REVISE, id: '1', cancel: '草稿那個算了不要' } as never)

  let saved = store.get(`wt:${ROOT}`) as { intents: Intent[] }
  expect(saved.intents.find(one => one.id === '1')?.closed?.by).toBe('person')
  expect(saved.intents.find(one => one.id === 'p1')?.closed?.isCascade).toBe(true)
  // The pane shows the latest only: the cancelled request and its part are gone from it.
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const shown = await texts(pane)
  expect(shown.some(x => x.endsWith(' 0/1') && /[▓░]/.test(x))).toBe(true)
  expect(shown.some(x => x.includes('草稿要保留') || x.includes('關掉 app 後還在'))).toBe(false)
  await pane.unmount()
  await $.tool.call({ tool: REVISE, id: '1', restore: true } as never)

  saved = store.get(`wt:${ROOT}`) as { intents: Intent[] }
  expect(saved.intents.every(one => !one.closed)).toBe(true)
  expect(saved.intents.find(one => one.id === '1')?.history?.map(h => h.what)).toEqual(['added', 'cancelled', 'restored'])
})

test('a changed request replaces the old one, which stays on record (not in the pane) and links to the new', async ($, on) => {
  const store = engine(on)
  await start($)
  await $.tool.call({ tool: ADD, intents: [{ summary: '草稿要保留', check: 'x', source: '關掉 app 後草稿要保留' }] } as never)
  await $.tool.call({ tool: MET, id: '1', evidence: '3/3' } as never)
  ui.messages = [...ui.messages, { role: 'user', text: '改成：草稿要自動存到雲端', toolUses: [] }]
  await $.tool.call({
    tool: ADD,
    intents: [{ summary: '草稿自動存雲端', check: 'y', source: '草稿要自動存到雲端', replaces: '1' }],
  } as never)

  const saved = store.get(`wt:${ROOT}`) as { intents: Intent[] }
  expect(saved.intents.find(one => one.id === '1')?.closed).toMatchObject({ as: 'replaced', replacedBy: '2' })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const shown = await texts(pane)
  // The new one is open: verified afresh, not done because the old one was.
  expect(shown).toContain('○ 2. 草稿自動存雲端')
  expect(shown.some(x => x.includes('1. 草稿要保留'))).toBe(false)
  await pane.unmount()
})

test('the person cancels in the pane; ⋯ shows their words, never a history', async ($, on) => {
  const store = engine(on)
  await seed($)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'details-1' })
  let shown = await texts(pane)
  expect(shown).toContain('  你說：「關掉 app 後草稿要保留」')
  // No history in the pane: the latest only.
  expect(shown.some(x => x.includes('歷史') || x.includes('Claude · 加入'))).toBe(false)
  await pane.press({ key: 'cancel-2' })
  expect(await texts(pane)).toContain('取消這一項？')
  await pane.press({ key: 'cancel-yes-2' })
  await pane.unmount()
  const saved = store.get(`wt:${ROOT}`) as { intents: Intent[] }
  expect(saved.intents.find(one => one.id === '2')?.closed).toMatchObject({ as: 'cancelled', by: 'person' })
})

test("after a turn where Claude already updated the list, the check adds nothing of the person's message twice", async ($, on) => {
  const store = engine(on)
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: 'done' }))
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: JSON.stringify({ onTrack: true, add: [{ quote: '匯出 PDF 要能選頁', kind: 'goal', summary: '可選頁匯出', check: 'x' }] }),
      usage: USAGE,
    },
  }))
  await seed($)
  setMessages(() => ({
    value: [
      { role: 'user', text: '匯出 PDF 要能選頁', toolUses: [] },
      { role: 'assistant', text: '好', toolUses: [{ tool_use_id: 'a', tool: ADD, input: { intents: [{ source: '匯出 PDF 要能選頁' }] } }] },
    ],
  }))
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await ui.clock.settle()
  expect((store.get(`wt:${ROOT}`) as { intents: Intent[] }).intents.length).toBe(2)
})

test("the person's dialog answers and the messages they type mid-turn count as their own words", async ($, on) => {
  engine(on)
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  await start($)
  setMessages(() => ({
    value: [
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 'q',
            tool: 'AskUserQuestion',
            input: {},
            text: 'Your questions have been answered: "要怎麼呈現？"="規劃階段＋分項歸屬 (建議)". You can now continue with these answers in mind.',
          },
        ],
      },
    ],
  }))
  // The question Claude wrote is not the person's word; their pick is.
  const question = await $.tool.call({ tool: ADD, intents: [{ summary: 'a', check: 'a', source: '要怎麼呈現' }] } as never)
  expect('deny' in question).toBe(true)
  const answer = await $.tool.call({ tool: ADD, intents: [{ summary: 'b', check: 'b', source: '規劃階段＋分項歸屬' }] } as never)
  expect('deny' in answer).toBe(false)

  // Typed over a running turn: never in the conversation's prompts, still theirs.
  await $.prompt.submit({ text: 'i regret, please dont leave any history in the pane', turnId: 't-running' } as never)
  const midTurn = await $.tool.call({
    tool: ADD,
    intents: [{ summary: 'c', check: 'c', source: 'please dont leave any history in the pane' }],
  } as never)
  expect('deny' in midTurn).toBe(false)
})

/** A request "修好草稿" (1) with three parts 1a–1c. */
async function seedParts($: Parameters<Parameters<typeof test>[1]>[0]) {
  await start($)
  await $.tool.call({
    tool: ADD,
    purpose: '修好草稿',
    intents: [
      { summary: '草稿不再消失', check: '整體', source: '修好草稿消失的問題' },
      { summary: '關掉 app 後草稿還在', check: 'DraftPersistTests', parent: '+1' },
      { summary: '切換筆記本後草稿還在', check: 'SwitchTests', parent: '+1' },
      { summary: '同步照常', check: 'SyncTests', parent: '+1' },
    ],
  } as never)
}

test('several parts can be worked on at once, each showing its own activity; a subagent\'s goes to the part it was sent for', async ($, on) => {
  engine(on)
  const running = heldTools(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'ag-1' }) as never)
  on('turn.complete', () => ({ text: 'done' }))
  await seedParts($)

  await $.tool.call({ tool: REVISE, id: '1a', active: true } as never)
  await $.tool.call({ tool: REVISE, id: '1b', agent: 'scan the switch code' } as never)
  await $.agent.spawn({ prompt: 'look', description: '[Opus High · FULL] scan the switch code' })
  // The subagent reads, then the main loop edits: while each runs, its own part shows it.
  await running(
    () => $.tool.call({ tool: 'Read', file_path: 'Switch.swift', agentId: 'ag-1' } as never),
    async () => {
      const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
      expect(await texts(pane)).toContain('  ● 1b. 切換筆記本後草稿還在  現在：調查')
      await pane.unmount()
    },
  )
  await running(
    () => $.tool.call({ tool: 'Edit', file_path: 'Draft.swift', old_string: 'a', new_string: 'b' } as never),
    async () => {
      const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
      const shown = await texts(pane)
      expect(shown).toContain('  ● 1a. 關掉 app 後草稿還在  現在：實作')
      expect(shown).toContain('  ● 1b. 切換筆記本後草稿還在  現在：思考中')
      await pane.unmount()
    },
  )

  // Both tools have returned: both loops are thinking now.
  let pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  let shown = await texts(pane)
  expect(shown).toContain('  ● 1a. 關掉 app 後草稿還在  現在：思考中')
  expect(shown).toContain('  ● 1b. 切換筆記本後草稿還在  現在：思考中')
  expect(shown).toContain('  ○ 1c. 同步照常')
  // With activity on the parts, no separate stage line under the bar.
  expect(shown.some(x => x.startsWith('現在：'))).toBe(false)
  await pane.unmount()

  // The subagent finishes: its part keeps ● but its activity clears.
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 's', reason: 'answer', agentId: 'ag-1' } as never)
  pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  shown = await texts(pane)
  expect(shown).toContain('  ● 1b. 切換筆記本後草稿還在')
  // Ticking a part ends its focus.
  await pane.unmount()
  await $.tool.call({ tool: MET, id: '1a', evidence: '3/3' } as never)
  pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'fold-1' })
  expect(await texts(pane)).toContain('  ✓ 1a. 關掉 app 後草稿還在')
  await pane.unmount()
})

test("Claude's changes to parts are told in one notice at the end of the turn; reordering relabels them", async ($, on) => {
  const store = engine(on)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? e))
    return { value: undefined }
  })
  on('turn.complete', () => ({ text: 'done' }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"onTrack": true}', usage: USAGE } }))
  await seedParts($)
  expect(toasts.length).toBe(0)

  await $.tool.call({ tool: ADD, intents: [{ summary: '當機後草稿還在', check: 'CrashTests', parent: '1' }] } as never)
  await $.tool.call({ tool: REVISE, id: '1c', cancel: '同步沒被動到，不用測' } as never)
  // After the cancel the new part is 1c (labels follow the live order).
  await $.tool.call({ tool: REVISE, id: '1c', position: 1 } as never)
  expect(toasts.length).toBe(0)
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  expect(toasts).toEqual(['Claude 新增了「當機後草稿還在」；Claude 取消了「同步照常」；Claude 移動了「當機後草稿還在」'])

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const shown = await texts(pane)
  expect(shown).toContain('  ○ 1a. 當機後草稿還在')
  expect(shown).toContain('  ○ 1b. 關掉 app 後草稿還在')
  expect(shown).toContain('  ○ 1c. 切換筆記本後草稿還在')
  await pane.unmount()
  expect((store.get(`wt:${ROOT}`) as { intents: Intent[] }).intents.find(one => one.ai === '同步照常')?.closed?.as).toBe('cancelled')
})

test('a result wakes the observer: it ticks what the output shows and flags a part the work has overtaken', async ($, on) => {
  const store = engine(on)
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: 'ok' }) as never)
  const prompts: string[] = []
  on('model.complete', (_, e) => {
    prompts.push(String((e as { prompt?: unknown }).prompt))
    return {
      value: {
        isAnswered: true,
        text: JSON.stringify({
          met: [{ id: '1a', evidence: 'DraftPersistTests：3 passed' }],
          stale: [{ id: '1b', why: '原因不在切換，而在存檔時機' }],
        }),
        usage: USAGE,
      },
    }
  })
  await seedParts($)
  setMessages(() => ({
    value: [
      { role: 'user', text: '修好草稿消失的問題', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'b', tool: 'Bash', input: { command: 'npm test' }, text: 'DraftPersistTests: 3 passed' }],
      },
    ],
  }))
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await ui.clock.advance(5_000)
  await ui.clock.settle()

  // A result pass asks only about ticks, breaks and stale parts.
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('DraftPersistTests: 3 passed')
  expect(prompts[0]).not.toContain('drift')
  const saved = store.get(`wt:${ROOT}`) as { intents: Intent[] }
  // Counted at once: evidence-quoted, no confirming needed.
  expect(saved.intents.find(one => one.id === 'p1')).toMatchObject({ isMet: true, isAuto: true })
  expect(saved.intents.find(one => one.id === 'p2')?.isStale).toBe(true)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'fold-1' })
  const shown = await texts(pane)
  expect(shown).toContain('  ✓ 1a. 關掉 app 後草稿還在（從輸出看到）')
  expect(shown).toContain('  ○ 1b. 切換筆記本後草稿還在（可能過時）')
  await pane.unmount()

  // Claude re-plans the stale part: the flag clears.
  await $.tool.call({ tool: REVISE, id: '1b', summary: '存檔時機正確，草稿不會掉' } as never)
  expect((store.get(`wt:${ROOT}`) as { intents: Intent[] }).intents.find(one => one.id === 'p2')?.isStale).toBe(false)
})

test('a changed request carries the parts that still apply to the new one', async ($, on) => {
  const store = engine(on)
  await seedParts($)
  ui.messages = [...ui.messages, { role: 'user', text: '改成：草稿要自動存到雲端', toolUses: [] }]
  await $.tool.call({
    tool: ADD,
    intents: [{ summary: '草稿自動存雲端', check: 'y', source: '草稿要自動存到雲端', replaces: '1' }],
  } as never)
  const saved = store.get(`wt:${ROOT}`) as { intents: Intent[] }
  expect(saved.intents.filter(one => one.parent === '2' && !one.closed).length).toBe(3)
})

test('the status is live: each tool shows its stage while it runs, thinking between tools, nothing once the turn ends', async ($, on) => {
  engine(on)
  const running = heldTools(on, e => ({ result: 'ok', ...(e.command === 'npm test' ? { isError: true } : {}) }))
  on('turn.complete', () => ({ text: 'done' }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"onTrack": true}', usage: USAGE } }))
  // seed()'s own tool calls go through the held tool too.
  await running(() => seed($), async () => {})
  const seen: string[] = []
  const look = async () => {
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    seen.push((await texts(pane)).find(x => x.startsWith('現在：')) ?? '')
    await pane.unmount()
  }
  await running(() => $.tool.call({ tool: 'Read', file_path: 'a.ts' } as never), look)
  await running(() => $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' } as never), look)
  await running(() => $.tool.call({ tool: 'Bash', command: 'npm test' } as never), look)
  // The test failed: the next edit is fixing.
  await running(() => $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'b', new_string: 'c' } as never), look)
  expect(seen).toEqual(['現在：調查', '現在：實作', '現在：測試', '現在：修正'])

  let pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  let shown = await texts(pane)
  expect(shown).toContain('現在：思考中')
  expect(shown.some(x => x.includes('›'))).toBe(false)
  await pane.unmount()

  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await texts(pane)).some(x => x.includes('現在'))).toBe(false)
  await pane.unmount()
})

test("after a turn, the person's missed request, drop or change is recorded from their own words only", async ($, on) => {
  const store = engine(on)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? e))
    return { value: undefined }
  })
  on('turn.complete', () => ({ text: 'done' }))
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: JSON.stringify({
        onTrack: true,
        cancel: [{ id: '2', quote: '同步那個不用管了' }],
        replace: [{ id: '1', quote: '草稿改成自動存雲端', summary: '草稿自動存雲端', check: '雲端看得到' }],
        // The second quote was never said: dropped.
        add: [
          { quote: '匯出 PDF 要能選頁', kind: 'goal', summary: '匯出 PDF 能選頁', check: '選 2 頁匯出得 2 頁' },
          { quote: '順便升級套件', kind: 'goal', summary: '升級套件', check: 'x' },
        ],
      }),
      usage: USAGE,
    },
  }))
  await seed($)
  setMessages(() => ({
    value: [
      { role: 'user', text: '同步那個不用管了。草稿改成自動存雲端，還有匯出 PDF 要能選頁', toolUses: [] },
      { role: 'assistant', text: '好', toolUses: [] },
    ],
  }))

  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await ui.clock.settle()

  const saved = store.get(`wt:${ROOT}`) as { intents: Intent[] }
  expect(saved.intents.find(one => one.id === '2')?.closed).toMatchObject({ as: 'cancelled', isAuto: true })
  expect(saved.intents.find(one => one.id === '1')?.closed).toMatchObject({ as: 'replaced', replacedBy: '3', isAuto: true })
  expect(saved.intents.find(one => one.id === '3')).toMatchObject({ ai: '草稿自動存雲端', isAuto: true, source: '草稿改成自動存雲端' })
  expect(saved.intents.find(one => one.id === '4')).toMatchObject({ ai: '匯出 PDF 能選頁', isAuto: true })
  expect(saved.intents.some(one => one.ai === '升級套件')).toBe(false)
  expect(toasts.some(x => x.includes('取消 2') && x.includes('取代 1') && x.includes('加入 1 項需求'))).toBe(true)

  // Claude confirms the auto entry.
  await $.tool.call({ tool: REVISE, id: '4', confirm: true } as never)
  expect((store.get(`wt:${ROOT}`) as { intents: Intent[] }).intents.find(one => one.id === '4')?.isAuto).toBe(false)
})

test('a message typed mid-turn still counts as the person\'s words after a reload, read from the transcript', async ($, on) => {
  engine(on)
  await start($)
  // No live capture (a reload lost it): only the transcript holds the message, beside a tool result.
  setMessages(() => ({
    value: [
      {
        role: 'user',
        text: 'The user sent a new message while you were working:\ni regret, please dont leave any history in the pane, just always show the latest\n\nThis is how Claude Code surfaces messages the user sends mid-turn.',
        toolUses: [],
        toolResults: [{ tool_use_id: 'x', text: 'ok' }],
      },
    ],
  }))
  const added = await $.tool.call({
    tool: ADD,
    intents: [{ summary: '只顯示最新', check: 'x', source: 'please dont leave any history in the pane, just always show the latest' }],
  } as never)
  expect('deny' in added).toBe(false)
  // The wrapper sentence is the engine's, not the person's.
  const wrapper = await $.tool.call({ tool: ADD, intents: [{ summary: 'y', check: 'y', source: 'This is how Claude Code surfaces messages' }] } as never)
  expect('deny' in wrapper).toBe(true)
})

test('work running in the background shows until it really ends: a background test until its notification, a subagent until it finishes', async ($, on) => {
  engine(on)
  on('tool.call', (_, e) =>
    ((e as { run_in_background?: boolean }).run_in_background
      ? { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg-7' } }
      : { result: 'ok' }) as never,
  )
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'ag-9' }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('turn.complete', () => ({ text: 'done' }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"onTrack": true}', usage: USAGE } }))
  await seed($)

  await $.tool.call({ tool: 'Bash', command: 'xcodebuild test -scheme App', description: '[shell] xcodebuild unit suite', run_in_background: true } as never)
  // Not sent for any part: the subagent shows on its own.
  await $.agent.spawn({ prompt: 'read docs', description: '[Fable High · FULL] scan the export docs', subagentType: 'Explore' })
  await $.tool.call({ tool: 'Grep', pattern: 'export', agentId: 'ag-9' } as never)
  // The main turn ends; both are still running.
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })

  let pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  let shown = await texts(pane)
  expect(shown).toContain('同時進行')
  expect(shown).toContain('  背景指令「xcodebuild unit suite」：測試')
  expect(shown).toContain('  子代理「scan the export docs」：思考中')
  await pane.unmount()

  // The subagent finishes; the background test's notification arrives.
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 's', reason: 'answer', agentId: 'ag-9' } as never)
  await $.prompt.submit({ text: '<task-notification>\n<task-id>bg-7</task-id>\n<status>completed</status>\n</task-notification>', isMeta: true } as never)
  pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  shown = await texts(pane)
  expect(shown.some(x => x.includes('同時進行') || x.includes('xcodebuild') || x.includes('scan the export'))).toBe(false)
  await pane.unmount()
})

test('running work is checked every few seconds against the facts: ended subagents leave, stopped or vanished commands leave, a quiet one says so', async ($, on) => {
  engine(on)
  on('tool.call', (_, e) => {
    const call = e as { tool?: string; command?: string; run_in_background?: boolean }
    if (call.run_in_background) {
      const id = call.command === 'npm test' ? 'bg-1' : 'bg-2'
      return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: id } } as never
    }
    return { result: 'ok' } as never
  })
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'ag-1' }) as never)
  await seed($)

  await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm run build', run_in_background: true } as never)
  await $.agent.spawn({ prompt: 'x', description: 'scan the docs' })
  // An agent started before a reload: running, never seen spawning.
  ui.agents = [
    { id: 'ag-1', description: 'scan the docs', type: 'Explore', status: 'running' },
    { id: 'ag-0', description: '[Opus High] audit the export path', type: 'general-purpose', status: 'running' },
  ]
  // Where the test writes, as the model read it; it last wrote 3 minutes ago.
  const path = '/tmp/session/tasks/bg-1.output'
  setMessages(() => ({
    value: [
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'b', tool: 'Bash', input: {}, text: `Command running in background with ID: bg-1. Output is being written to: ${path}` }],
      },
    ],
  }))
  ui.files[path] = ui.clock.now() - 3 * 60_000
  await ui.clock.advance(5_000)
  await ui.clock.settle()

  let pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  let shown = await texts(pane)
  expect(shown).toContain('  背景指令「npm test」：測試（3 分鐘沒有新輸出）')
  expect(shown).toContain('  背景指令「npm run build」：建置')
  expect(shown).toContain('  子代理「scan the docs」：思考中')
  expect(shown).toContain('  子代理「audit the export path」：思考中')
  await pane.unmount()

  // The build is stopped by hand; the test's output file vanishes; the subagents end.
  await $.tool.call({ tool: 'TaskStop', task_id: 'bg-2' } as never)
  delete ui.files[path]
  ui.agents = ui.agents.map(agent => ({ ...agent, status: agent.id === 'ag-1' ? 'completed' : 'killed' }))
  await ui.clock.advance(5_000)
  await ui.clock.settle()
  pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  shown = await texts(pane)
  expect(shown.some(x => x.includes('同時進行') || x.includes('背景指令') || x.includes('子代理'))).toBe(false)
  await pane.unmount()
})

test('the progress bar fills the pane width on the terminal', async ($, on) => {
  engine(on)
  await seed($)
  await $.tool.call({ tool: MET, id: '1', evidence: 'ok' } as never)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const bar = (await texts(pane)).find(x => /[▓░]/.test(x)) ?? ''
  // 50 columns: 46 cells of bar, a space, "1/2".
  expect(bar).toBe(`${'▓'.repeat(23)}${'░'.repeat(23)} 1/2`)
  await pane.unmount()
})

test("the person's message is recorded before the work: a reminder rides with it, and a second one if Claude starts working first", async ($, on) => {
  engine(on)
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('tool.call', () => ({ result: 'ok' }) as never)
  await seed($)

  const sent = await $.prompt.submit({ text: '把進度條改成全寬' })
  expect('context' in sent && sent.context?.some(c => c.includes('record it on the list first'))).toBe(true)
  // Claude reads a file before recording anything: that first result carries the second reminder, once.
  const first = await $.tool.call({ tool: 'Read', file_path: 'a.ts' } as never)
  expect('context' in first && first.context?.some(c => c.includes('You started working without recording'))).toBe(true)
  const again = await $.tool.call({ tool: 'Read', file_path: 'b.ts' } as never)
  expect('context' in again && (again.context ?? []).some(c => c.includes('You started working without recording'))).toBe(false)

  // Recorded first: no second reminder.
  await $.prompt.submit({ text: '再把顏色改淡' })
  await $.tool.call({ tool: REVISE, id: '1', check: 'DraftPersistTests 3/3' } as never)
  const work = await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' } as never)
  expect('context' in work && (work.context ?? []).some(c => c.includes('You started working without recording'))).toBe(false)
})

test("a small follow-up to a request goes under it with the person's words, and the request opens again", async ($, on) => {
  const store = engine(on)
  await seed($)
  await $.tool.call({ tool: MET, id: '1', evidence: '3/3' } as never)
  ui.messages = [...ui.messages, { role: 'user', text: '草稿也要在當機後保留', toolUses: [] }]

  const invented = await $.tool.call({ tool: ADD, intents: [{ summary: 'x', check: 'x', parent: '1', source: '順便加快' }] } as never)
  expect('deny' in invented).toBe(true)
  await $.tool.call({ tool: ADD, intents: [{ summary: '當機後草稿還在', check: 'CrashTests', parent: '1', source: '草稿也要在當機後保留' }] } as never)

  const saved = store.get(`wt:${ROOT}`) as { intents: Intent[] }
  expect(saved.intents.find(one => one.id === 'p1')).toMatchObject({ parent: '1', source: '草稿也要在當機後保留' })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const shown = await texts(pane)
  // Request 1 is open again: its follow-up is not done.
  expect(shown).toContain('○ 1. 關掉 app 後草稿要保留 0/1')
  expect(shown).toContain('  ○ 1a. 當機後草稿還在')
  await pane.unmount()
})

test("the observer files a person's small follow-up under the request it refines", async ($, on) => {
  const store = engine(on)
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: 'done' }))
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: JSON.stringify({ onTrack: true, add: [{ quote: '草稿也要在當機後保留', kind: 'goal', parent: '1', summary: '當機後草稿還在', check: 'CrashTests' }] }),
      usage: USAGE,
    },
  }))
  await seed($)
  setMessages(() => ({ value: [{ role: 'user', text: '草稿也要在當機後保留', toolUses: [] }, { role: 'assistant', text: '好', toolUses: [] }] }))
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await ui.clock.settle()
  const saved = store.get(`wt:${ROOT}`) as { intents: Intent[] }
  expect(saved.intents.find(one => one.ai === '當機後草稿還在')).toMatchObject({ parent: '1', isAuto: true, source: '草稿也要在當機後保留' })
})

test('the status says when the session is waiting on the person: a question asked, a plan up for approval, or a reply ending in a question', async ($, on) => {
  engine(on)
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('turn.complete', () => ({ text: 'done' }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"onTrack": true}', usage: USAGE } }))
  const running = heldTools(on)
  await running(() => seed($), async () => {})
  const now = async () => {
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const line = (await texts(pane)).find(x => x.startsWith('現在：')) ?? ''
    await pane.unmount()
    return line
  }

  let seen = ''
  await running(() => $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never), async () => {
    seen = await now()
  })
  expect(seen).toBe('現在：等你回答')
  await running(() => $.tool.call({ tool: 'ExitPlanMode', plan: 'x' } as never), async () => {
    seen = await now()
  })
  expect(seen).toBe('現在：等你核准計畫')

  // A reply ending in a question keeps waiting after the turn; the person's next message ends it.
  await $.turn.complete({ answer: '已完成。\n\n要我順便修好嗎？', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  expect(await now()).toBe('現在：等你回答')
  await $.prompt.submit({ text: '好' })
  expect(await now()).toBe('')
  // A reply that asks nothing leaves nothing waiting.
  await $.turn.complete({ answer: '完成了。', durationMs: 1, isAborted: false, turnId: 'u', reason: 'answer' })
  expect(await now()).toBe('')
})

test('a wrong id is refused with a short key of the items, and an add says which labels it made', async ($, on) => {
  engine(on)
  await start($)
  const added = await $.tool.call({
    tool: ADD,
    intents: [
      { summary: '草稿要保留', check: 'x', source: '關掉 app 後草稿要保留' },
      { summary: '關掉還在', check: 'y', parent: '+1' },
      { summary: '切換還在', check: 'z', parent: '+1' },
    ],
  } as never)
  expect('result' in added && String(added.result).startsWith('Added: 1, 1a, 1b')).toBe(true)
  const wrong = await $.tool.call({ tool: MET, id: '2a', evidence: 'x' } as never)
  expect('deny' in wrong && wrong.deny).toBe('No item "2a". Items (parts by label): 1 (1a, 1b)')
})

test('finished parts fold under their request (▸ opens them) and show green; request numbers run on without gaps', async ($, on) => {
  const store = engine(on)
  await seedParts($)
  await $.tool.call({ tool: MET, id: '1a', evidence: 'ok' } as never)
  // The next request is 2: its parts did not use up numbers.
  ui.messages = [...ui.messages, { role: 'user', text: '桌面版也要能用', toolUses: [] }]
  await $.tool.call({ tool: ADD, intents: [{ summary: '桌面版可用', check: 'x', source: '桌面版也要能用' }] } as never)
  expect((store.get(`wt:${ROOT}`) as { intents: Intent[] }).intents.some(one => one.id === '2' && !one.parent)).toBe(true)

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  let shown = await texts(pane)
  expect(shown).toContain('◐ 1. 草稿不再消失 1/3')
  expect(shown.some(x => x.includes('1a.'))).toBe(false)
  expect(shown).toContain('  ○ 1b. 切換筆記本後草稿還在')
  expect((await pane.find({ type: 'Button', key: 'fold-1' }))?.text).toBe('▸')
  await pane.press({ key: 'fold-1' })
  shown = await texts(pane)
  expect(shown).toContain('  ✓ 1a. 關掉 app 後草稿還在')
  expect((await pane.find({ type: 'Text', text: /1a\. 關掉/ }))?.props.color).toBe('green')
  await pane.press({ key: 'fold-1' })
  expect((await texts(pane)).some(x => x.includes('1a.'))).toBe(false)
  await pane.unmount()
})

test("Claude recording words the observer already recorded takes that entry's place; an unconfirmed auto entry can be withdrawn without a quote", async ($, on) => {
  const store = engine(on)
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: 'done' }))
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: JSON.stringify({
        onTrack: true,
        add: [
          { quote: '完成的分項要變綠色', kind: 'goal', summary: '分項變綠', check: 'x' },
          { quote: '匯出要能選頁', kind: 'goal', summary: '選頁匯出', check: 'y' },
        ],
      }),
      usage: USAGE,
    },
  }))
  await seed($)
  setMessages(() => ({ value: [{ role: 'user', text: '完成的分項要變綠色，匯出要能選頁', toolUses: [] }, { role: 'assistant', text: '好', toolUses: [] }] }))
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await ui.clock.settle()

  await $.tool.call({ tool: ADD, intents: [{ summary: '完成的分項變綠', check: 'z', parent: '1', source: '完成的分項要變綠色' }] } as never)
  let saved = store.get(`wt:${ROOT}`) as { intents: Intent[] }
  expect(saved.intents.find(one => one.ai === '分項變綠')?.closed).toMatchObject({ as: 'replaced', replacedBy: 'p1' })
  // Not the person's word, but an unconfirmed auto entry: Claude may withdraw it.
  const auto = saved.intents.find(one => one.ai === '選頁匯出') as Intent
  const withdrawn = await $.tool.call({ tool: REVISE, id: auto.id, cancel: '重複' } as never)
  expect('deny' in withdrawn).toBe(false)
  saved = store.get(`wt:${ROOT}`) as { intents: Intent[] }
  expect(saved.intents.find(one => one.id === auto.id)?.closed?.as).toBe('cancelled')
})
