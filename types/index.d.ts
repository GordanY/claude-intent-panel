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
    }
  }
}
