export type Intent = {
  /** Short stable id the model refers to: "1", "2", ... */
  id: string
  /** Claude's plain-language summary (Traditional Chinese). */
  ai: string
  /** The person's own words, typed in the pane; '' until they write some. */
  mine: string
  /** The concrete check that proves the goal is met. */
  check: string
  isMet: boolean
  /** What was run or observed when the check passed; '' while open. */
  evidence: string
}

export type Purpose = { ai: string; mine: string }

export type Drift = { note: string; isByUser: boolean }

export type Lang = { code: 'en' | 'zh' | 'ja' | 'custom'; custom?: string }

declare module 'claude-code' {
  interface PluginState {
    'intent-tracker': {
      intents: Shaped<Intent[]>
      purpose: Shaped<Purpose>
      drift: Shaped<Drift | null>
      /** Which field is being edited: an intent id, 'purpose', or null. */
      editing: string | null
      /** The person changed their words since the model last saw the list. */
      isDirty: boolean
      /** The worktree root whose saved list is loaded; null before the first load. */
      loadedRoot: string | null
      /** The person closed the pane by hand in this session: list changes no longer reopen it. */
      isClosedByPerson: boolean
      /** When the list last changed (ms since the epoch); null before any change. */
      updatedAt: number | null
      /** The clock the footer's "N 分鐘前" reads, ticked once a minute. */
      now: number
      /** The pane's language, loaded from $.store at session start. */
      lang: Lang
      /** A person can see this session (not `-p`, not the SDK): the mod acts only then. */
      isActive: boolean
    }
  }
}
