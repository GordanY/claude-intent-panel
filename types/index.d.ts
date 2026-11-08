/** Who made a change: the person (pane or their words), Claude, or the end-of-turn check. */
export type Actor = 'person' | 'claude' | 'auto'

export type HistoryWhat =
  | 'added'
  | 'edited'
  | 'met'
  | 'reopened'
  | 'confirmed'
  | 'cancelled'
  | 'replaced'
  | 'restored'
  | 'broken'
  | 'holding'
  | 'moved'

export type HistoryEntry = { at: number; by: Actor; what: HistoryWhat; note?: string }

/** Why an item left the list: dropped, or replaced by another (the person changed what they want). */
export type Closed = {
  as: 'cancelled' | 'replaced'
  reason: string
  by: Actor
  at: number
  replacedBy?: string
  /** Closed because its request was: restored with it. */
  isCascade?: boolean
  /** Applied by the end-of-turn check; not yet confirmed. */
  isAuto?: boolean
}

/** A limit a result showed broken. */
export type Broken = { evidence: string; at: number; isAuto?: boolean }

/** A planned stage of a request, in order; its parts name it. */
export type Phase = {
  /** Stable id the tools use: "P1", "P2", ... (the pane numbers phases by position). */
  id: string
  title: string
  /** A phase with no parts is marked done by hand; one with parts is done when they all are. */
  isDone?: boolean
  closed?: Closed
}

export type Intent = {
  /** Short stable id the model refers to: "1", "2", ... */
  id: string
  /** Claude's plain-language summary, in the pane's language. */
  ai: string
  /** The person's own words, typed in the pane; '' until they write some. */
  mine: string
  /** The concrete check that proves the goal is met (for a limit: that it still holds). */
  check: string
  isMet: boolean
  /** What was run or observed when the check passed; '' while open. */
  evidence: string
  /**
   * Ticked by the end-of-turn check from the turn's tool output, not yet
   * confirmed by the main conversation.
   */
  isAuto?: boolean
  /** A goal (an outcome) or a limit (must not happen / must stay as it is). Absent: goal. */
  kind?: 'goal' | 'limit'
  /**
   * A request (no parent): the person's own words that asked for it, checked
   * against the conversation. A part (with parent) inherits its request's.
   */
  source?: string
  /** A part of this request: Claude's breakdown of what the person asked into plain outcomes. */
  parent?: string
  closed?: Closed
  broken?: Broken
  history?: HistoryEntry[]
  /** Planned phases of v0.12 (no longer used; kept so older lists load). */
  phases?: Phase[]
  phase?: string
  /** Being worked on now, by Claude or a subagent sent for it; any number at once. */
  isActive?: boolean
  /** Words of the description of the subagent sent for this part; links its activity here. */
  agent?: string
  /** The work shows it may no longer apply: Claude re-plans it. */
  isStale?: boolean
}

/** Where the work is now: plan, investigate, build, test, fix (after a failed test), review. */
export type StageKey = 'plan' | 'investigate' | 'build' | 'test' | 'fix' | 'review'

export type Stage = { now: StageKey | null; seen: StageKey[]; at: number; isTestFailing: boolean }

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
      /** The model the drift check runs on (an alias), loaded from $.store at session start. */
      driftModel: string
      /** A person can see this session (not `-p`, not the SDK): the mod acts only then. */
      isActive: boolean
      /** Where the work is now, from the session's own tool calls (this session only). */
      stage: Shaped<Stage>
      /** Each active part's live activity (this session): part id → stage. */
      activity: Record<string, StageKey>
      /** Running subagents linked to a part: agent id → part id. */
      agentLinks: Record<string, string>
      /** Subagents started in this session, by id: their description (to link them later). */
      spawned: Record<string, string>
      /** When the observer's pending pass after a burst of results is due (ms since the epoch). */
      observeAt: number
      /** How far into the conversation the observer has read tool output (message count). */
      observed: number
      /** Changes Claude made to parts this turn, told to the person in one notice at its end. */
      notes: string[]
      /** What the person typed in this session (prompts, mid-turn messages, dialog answers), newest last. */
      heardSaid: { text: string; at: number }[]
      /** The item whose details (source, history) are shown; one at a time. */
      shownDetails: string | null
      /** The finished goals are expanded in the pane. */
      isDoneOpen: boolean
    }
  }
}
