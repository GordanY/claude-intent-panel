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
const ui = { up: new Set<string>(), opens: 0, clock: null as unknown as ReturnType<typeof mock.clock> }

/** The engine beneath the mod; `dirs` are the folders that exist. */
function engine(on: On, initial: Record<string, unknown> = {}, dirs: string[] = [ROOT, '/repo/.claude/worktrees']) {
  const store = new Map<string, unknown>(Object.entries(initial))
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
  on('tool.register', () => ({ value: {} }))
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
  expect((await ui.find({ type: 'Text', text: /已達成/ }))?.text).toBe('已達成 0/2')
  expect((await ui.find({ type: 'Text', text: /草稿要保留/ }))?.text).toBe('○ 1. 關掉 app 後草稿要保留')
  expect((await ui.find({ type: 'Text', text: /檢查：DraftPersist/ }))?.text).toBe('檢查：DraftPersistTests 通過')
  await ui.unmount()

  const refused = await $.tool.call({ tool: MET, id: '1', evidence: '' } as never)
  expect('deny' in refused && typeof refused.deny === 'string').toBe(true)

  await $.tool.call({ tool: MET, id: '1', evidence: 'DraftPersistTests 3/3 通過' } as never)
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /已達成/ }))?.text).toBe('已達成 1/2')
  expect((await ui.find({ type: 'Text', text: /草稿要保留/ }))?.text).toBe('✓ 1. 關掉 app 後草稿要保留')
  expect((await ui.find({ type: 'Text', text: /依據/ }))?.text).toBe('依據：DraftPersistTests 3/3 通過')
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
  await ui.input({ key: 'mine-1', text: '草稿絕對不能不見' })
  expect((await ui.find({ type: 'Text', text: /你：草稿/ }))?.text).toBe('你：草稿絕對不能不見')
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
  expect((await ui.find({ type: 'Text', text: /已達成/ }))?.text).toBe('已達成 1/1')
  expect((await ui.find({ type: 'Text', text: /你：草稿/ }))?.text).toBe('你：草稿絕對不能不見')
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
  expect((await after.find({ type: 'Text', text: /還沒有目標/ }))?.text).toBe('還沒有目標。開始描述這次要做的事，Claude 會在這裡整理出來。')
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
  expect((await view.find({ type: 'Text', text: /已達成/ }))?.text).toBe('已達成 0/3')
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
  expect((await pane.find({ type: 'Text', text: /最後更新/ }))?.text).toBe('最後更新：剛剛')
  expect((await pane.find({ type: 'Text', text: /摘要・打勾/ }))?.text).toBe('摘要・打勾：Opus 5.5（主對話）')
  expect((await pane.find({ type: 'Text', text: /偏題檢查/ }))?.text).toBe('偏題檢查：Haiku')
  expect((await pane.find({ type: 'Text', text: /^─+$/ }))).toBeDefined()
  await pane.unmount()

  await ui.clock.advance(10 * 60_000)
  pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /最後更新/ }))?.text).toBe('最後更新：10 分鐘前')
  await pane.unmount()

  await $.tool.call({ tool: MET, id: '1', evidence: '通過' } as never)
  pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: /最後更新/ }))?.text).toBe('最後更新：剛剛')
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
