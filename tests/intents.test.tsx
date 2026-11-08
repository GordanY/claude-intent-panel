import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'intent-tracker',
  component: 'Pane',
  requestId: 'intents',
  props: {
    title: '🎯 本次目標',
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
const ui = { up: new Set<string>(), opens: 0, registered: 0, clock: null as unknown as ReturnType<typeof mock.clock> }

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
  on('fs.stat', (_, e) => {
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
      { summary: '關掉 app 後草稿要保留', check: 'DraftPersistTests 通過' },
      { summary: '不要動到同步', check: 'diff 不含 Sync/' },
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
  expect((await ui.find({ type: 'Text', text: /[▓░]/ }))?.text?.endsWith(' 1/2')).toBe(true)
  // Done goals fold to one line until opened.
  expect(await ui.find({ type: 'Text', text: /草稿要保留/ })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'done-toggle' }))?.text).toBe('✓ 已完成 1 項 ▸')
  await ui.press({ key: 'done-toggle' })
  expect((await ui.find({ type: 'Text', text: /草稿要保留/ }))?.text).toBe('✓ 1. 關掉 app 後草稿要保留')
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
  expect('context' in second && (second.context ?? []).length).toBe(0)
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
  on('session.messages', () => ({
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
  await $.tool.call({ tool: ADD, intents: [{ summary: '多一個目標', check: '看得到' }] } as never)
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
  expect((await pane.find({ type: 'Text', text: /Haiku/ }))?.text).toBe('剛剛 · Opus 5.5 · 偏題 Haiku · ')
  expect((await pane.find({ type: 'Button', key: 'lang' }))?.text).toBe('🌐 中文')
  expect((await pane.find({ type: 'Text', text: /^─+$/ }))).toBeDefined()
  await pane.unmount()

  await ui.clock.advance(10 * 60_000)
  pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /Haiku/ }))?.text).toBe('10 分鐘前 · Opus 5.5 · 偏題 Haiku · ')
  await pane.unmount()

  await $.tool.call({ tool: MET, id: '1', evidence: '通過' } as never)
  pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /Haiku/ }))?.text).toBe('剛剛 · Opus 5.5 · 偏題 Haiku · ')
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
  expect((await pane.find({ type: 'Text', text: /Haiku/ }))?.text).toBe('just now · Opus 5.5 · drift Haiku · ')
  expect((await pane.find({ type: 'Button', key: 'refresh-ai' }))?.text).toBe('↻ Refresh AI content')
  expect((await pane.find({ type: 'Button', key: 'lang' }))?.text).toBe('🌐 English')

  await pane.press({ key: 'lang' })
  await pane.press({ key: 'lang-ja' })
  await pane.unmount()
  expect(store.get('settings:lang')).toEqual({ code: 'ja' })

  pane = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 60 }, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /Haiku/ }))?.text).toBe('たった今 · Opus 5.5 · 脱線 Haiku · ')
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
  on('session.messages', () => ({ value: [{ role: 'user', text: '做事', toolUses: [] }, { role: 'assistant', text: '好', toolUses: [] }] }))
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
  expect((await pane.find({ type: 'Text', text: /[▓░]/ }))?.text?.endsWith(' 1/2')).toBe(true)
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
  await $.tool.call({ tool: ADD, purpose: '桌面版也能用', intents: [{ summary: '面板出現', check: '看得到' }] } as never)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /面板出現/ }))?.text).toBe('○ 1. 面板出現')
  await pane.unmount()
})
