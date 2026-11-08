// The pane's languages. The chosen one sets the pane's own labels (English,
// 中文, 日本語; a custom language uses English labels) and the language Claude
// writes the purpose, goals, checks, evidence and drift notes in.

export type LangCode = 'en' | 'zh' | 'ja' | 'custom'
export type Lang = { code: LangCode; custom?: string }

export const DEFAULT_LANG: Lang = { code: 'en' }

/** Reads a stored choice, falling back to the default for anything else. */
export function asLang(value: unknown): Lang {
  if (typeof value !== 'object' || value === null) return DEFAULT_LANG
  const v = value as Partial<Lang>
  if (v.code === 'en' || v.code === 'zh' || v.code === 'ja') return { code: v.code }
  if (v.code === 'custom' && typeof v.custom === 'string' && v.custom.trim()) return { code: 'custom', custom: v.custom.trim() }
  return DEFAULT_LANG
}

/** The language as Claude is told to write in it. */
export function langName(lang: Lang): string {
  switch (lang.code) {
    case 'zh':
      return '繁體中文 (Traditional Chinese)'
    case 'ja':
      return '日本語 (Japanese)'
    case 'custom':
      return lang.custom ?? 'English'
    default:
      return 'English'
  }
}

/** The language as the picker shows it. */
export function langLabel(lang: Lang): string {
  switch (lang.code) {
    case 'zh':
      return '中文'
    case 'ja':
      return '日本語'
    case 'custom':
      return lang.custom ?? 'English'
    default:
      return 'English'
  }
}

export type Tools = { add: string; list: string; met: string; revise: string }

export type Strings = {
  title: string
  command: string
  opened: string
  empty: string
  doneGroup: (n: number) => string
  driftShort: string
  /** Footer label for the session's own model, which writes the goals and ticks them. */
  mainShort: string
  start: string
  refresh: string
  clear: string
  close: string
  toastStart: string
  toastRefresh: string
  confirmClear: string
  clearYes: string
  cancel: string
  purpose: string
  ai: string
  you: string
  minePlaceholder: string
  save: string
  edit: string
  notYet: string
  met: string
  check: string
  evidence: string
  noCheck: string
  drift: string
  byUser: string
  addToList: string
  ignore: string
  lastUpdate: string
  justNow: string
  minutes: (n: number) => string
  hours: (n: number) => string
  days: (n: number) => string
  summaries: string
  mainSession: string
  driftCheck: string
  language: string
  customOption: string
  customPlaceholder: string
  colon: string
  paren: (text: string) => string
  autoMark: string
  autoCount: (n: number) => string
  toastAuto: (ids: readonly string[]) => string
  startPrompt: (tools: Tools, lang: string) => string
  refreshPrompt: (tools: Tools, lang: string) => string
}

const EN: Strings = {
  title: 'Goals',
  command: 'Open the goals pane',
  opened: 'Goals pane opened.',
  empty: 'No goals yet.',
  doneGroup: n => `${n} done`,
  driftShort: 'drift',
  mainShort: 'goals',
  start: 'Start',
  refresh: 'Refresh AI content',
  clear: 'Clear list',
  close: 'Close',
  toastStart: 'Asked Claude to build the purpose and goals from the conversation',
  toastRefresh: 'Asked Claude to refresh the AI content (your words stay as they are)',
  confirmClear: "Clear this worktree's list?",
  clearYes: 'Clear',
  cancel: 'Cancel',
  purpose: 'Purpose',
  ai: 'AI',
  you: 'You',
  minePlaceholder: 'In your own words, Enter to save',
  save: 'save',
  edit: 'edit',
  notYet: '(not written yet)',
  met: 'Met',
  check: 'Check',
  evidence: 'Evidence',
  noCheck: '(none yet)',
  drift: 'Off track',
  byUser: ' (you asked)',
  addToList: 'Add to list',
  ignore: 'Ignore',
  lastUpdate: 'Last update',
  justNow: 'just now',
  minutes: n => `${n} min ago`,
  hours: n => `${n} h ago`,
  days: n => `${n} d ago`,
  summaries: 'Summaries & ticks',
  mainSession: 'main session',
  driftCheck: 'Drift check',
  language: 'Language',
  customOption: 'Custom…',
  customPlaceholder: 'Type a language, Enter to save',
  colon: ': ',
  paren: text => ` (${text})`,
  autoMark: 'auto, unconfirmed',
  autoCount: n => `${n} auto`,
  toastAuto: ids => `Auto-ticked goal ${ids.join(', ')} from this turn's output (Claude confirms it next)`,
  startPrompt: (t, lang) =>
    `(Goals pane) From the conversation so far, set out what this work is for and its goals: use ${t.add} to set a one-line plain-language purpose and the goals I actually want (as many as the work really has), each with a concrete check; tick goals already verified in the conversation with ${t.met} and the evidence. ` +
    `Use only what actually happened in the conversation; if it is not yet clear what we are doing, just ask me. Write everything in ${lang}. When done, tell me in a sentence or two.`,
  refreshPrompt: (t, lang) =>
    `(Goals pane) From the current conversation, refresh the AI content of the goals pane: the purpose and each goal's plain-language summary, check and tick state. ` +
    `First read the list with ${t.list}, then update it with ${t.revise} (the purpose through its purpose field); reopen goals whose check did not actually pass, and tick verified ones with ${t.met} and the evidence. ` +
    `Write everything in ${lang}. Do not change my own words; where they differ from your summary, mine win. When done, tell me in a sentence or two what changed.`,
}

const ZH: Strings = {
  title: '本次目標',
  command: '打開本次目標面板',
  opened: '已打開本次目標面板。',
  empty: '還沒有目標。',
  doneGroup: n => `已完成 ${n} 項`,
  driftShort: '偏題',
  mainShort: '整理',
  start: '開始整理',
  refresh: '重新整理 AI 內容',
  clear: '清空清單',
  close: '關閉',
  toastStart: '已請 Claude 依目前的對話整理原意和目標',
  toastRefresh: '已請 Claude 重新整理 AI 內容（你寫的字不會動）',
  confirmClear: '確定清空這個 worktree 的清單？',
  clearYes: '清空',
  cancel: '取消',
  purpose: '原意',
  ai: 'AI',
  you: '你',
  minePlaceholder: '用你自己的話寫，Enter 儲存',
  save: '儲存',
  edit: '改',
  notYet: '（尚未整理）',
  met: '已達成',
  check: '檢查',
  evidence: '依據',
  noCheck: '（未定）',
  drift: '偏題',
  byUser: '（你要求的）',
  addToList: '加入清單',
  ignore: '忽略',
  lastUpdate: '最後更新',
  justNow: '剛剛',
  minutes: n => `${n} 分鐘前`,
  hours: n => `${n} 小時前`,
  days: n => `${n} 天前`,
  summaries: '摘要・打勾',
  mainSession: '主對話',
  driftCheck: '偏題檢查',
  language: '語言',
  customOption: '自訂…',
  customPlaceholder: '輸入一種語言，Enter 儲存',
  colon: '：',
  paren: text => `（${text}）`,
  autoMark: '自動・待確認',
  autoCount: n => `${n} 項自動`,
  toastAuto: ids => `已依這回合的輸出自動勾選目標 ${ids.join('、')}（Claude 下次會確認）`,
  startPrompt: (t, lang) =>
    '（目標面板）請依目前為止的對話，整理這次工作的原意和目標：' +
    `用 ${t.add} 設定一行白話的原意，和我真正想要的目標（有幾個就列幾個）（每個附具體的檢查方式）；` +
    `對話裡已經確實跑過、也通過檢查的目標，再用 ${t.met} 補上依據打勾。` +
    `只根據對話裡真的發生過的事；如果對話還看不出要做什麼，就直接問我。全部用${lang}寫。整理完用一兩句話告訴我。`,
  refreshPrompt: (t, lang) =>
    '（目標面板）請依目前的對話，重新整理目標面板裡的 AI 內容：原意和每個目標的白話摘要、檢查方式、打勾狀態。' +
    `先用 ${t.list} 讀目前的清單，再用 ${t.revise} 更新（原意用它的 purpose 欄位）；檢查其實沒有通過的目標用 reopen 取消打勾，確實通過但還沒勾的用 ${t.met} 補上依據。` +
    `全部用${lang}寫。不要改動我自己寫的字；我的字跟你的摘要不一致時，以我的字為準。整理完用一兩句話告訴我改了什麼。`,
}

const JA: Strings = {
  title: '今回の目標',
  command: '目標パネルを開く',
  opened: '目標パネルを開きました。',
  empty: 'まだ目標がありません。',
  doneGroup: n => `${n} 件完了`,
  driftShort: '脱線',
  mainShort: '整理',
  start: '整理開始',
  refresh: 'AI 内容を更新',
  clear: 'リストを消去',
  close: '閉じる',
  toastStart: 'これまでの会話から目的と目標を整理するよう Claude に依頼しました',
  toastRefresh: 'AI 内容の更新を Claude に依頼しました（あなたの言葉は変わりません）',
  confirmClear: 'この worktree のリストを消去しますか？',
  clearYes: '消去',
  cancel: 'キャンセル',
  purpose: '目的',
  ai: 'AI',
  you: 'あなた',
  minePlaceholder: '自分の言葉で書く（Enter で保存）',
  save: '保存',
  edit: '編集',
  notYet: '（未整理）',
  met: '達成',
  check: '確認方法',
  evidence: '根拠',
  noCheck: '（未定）',
  drift: '脱線',
  byUser: '（依頼したもの）',
  addToList: 'リストに追加',
  ignore: '無視',
  lastUpdate: '最終更新',
  justNow: 'たった今',
  minutes: n => `${n} 分前`,
  hours: n => `${n} 時間前`,
  days: n => `${n} 日前`,
  summaries: '要約・チェック',
  mainSession: 'メイン会話',
  driftCheck: '脱線チェック',
  language: '言語',
  customOption: 'その他…',
  customPlaceholder: '言語を入力（Enter で保存）',
  colon: '：',
  paren: text => `（${text}）`,
  autoMark: '自動・未確認',
  autoCount: n => `${n} 件自動`,
  toastAuto: ids => `このターンの出力から目標 ${ids.join('、')} を自動チェックしました（次に Claude が確認します）`,
  startPrompt: (t, lang) =>
    '（目標パネル）これまでの会話から、この作業の目的と目標を整理してください：' +
    `${t.add} で一行の平易な目的と、私が本当に望む目標を数を決めずに必要なだけ（それぞれ具体的な確認方法つき）設定し、会話の中で実際に確認済みの目標は ${t.met} で根拠をつけてチェックしてください。` +
    `会話で実際に起きたことだけに基づき、まだ何をするか分からなければ私に聞いてください。すべて${lang}で書いてください。終わったら一、二文で教えてください。`,
  refreshPrompt: (t, lang) =>
    '（目標パネル）現在の会話に基づいて、目標パネルの AI 内容（目的、各目標の平易な要約、確認方法、チェック状態）を更新してください。' +
    `まず ${t.list} でリストを読み、${t.revise} で更新します（目的は purpose 欄）。確認が実際には通っていない目標は reopen で外し、確認済みでまだチェックされていないものは ${t.met} で根拠をつけてください。` +
    `すべて${lang}で書いてください。私自身の言葉は変えないでください。あなたの要約と食い違う場合は私の言葉を優先します。終わったら何を変えたか一、二文で教えてください。`,
}

/** The pane's labels: English for a custom language. */
export function strings(lang: Lang): Strings {
  if (lang.code === 'zh') return ZH
  if (lang.code === 'ja') return JA
  return EN
}

/** "just now", "10 min ago", ... in the pane's language. */
export function ago(t: Strings, at: number, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - at) / 60_000)
  if (minutes < 1) return t.justNow
  if (minutes < 60) return t.minutes(minutes)
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t.hours(hours)
  return t.days(Math.floor(hours / 24))
}
