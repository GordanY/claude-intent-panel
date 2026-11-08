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
  on('ui.open', () => ({ value: { isPlaced: true } }))
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
  expect((await after.find({ type: 'Text' }))?.text).toBe('還沒有目標。開始描述這次要做的事，Claude 會在這裡整理出來。')
  await after.unmount()
})

test('an off-list turn raises a drift warning that can be added to the list', async ($, on) => {
  const store = engine(on)
  const clock = mock.clock(on)
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

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /偏題/ }))?.text).toBe('⚠️ 偏題：改了 CI 的等待時間')
  await ui.press({ key: 'drift-add' })
  await ui.unmount()

  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /偏題/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /已達成/ }))?.text).toBe('已達成 0/3')
  await ui.unmount()
})
