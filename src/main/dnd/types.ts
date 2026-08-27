/** Public shape of the Do Not Disturb state, shared with the status view. */
export interface DndState {
  /** True when native notifications must be suppressed. */
  readonly active: boolean;
  /** Which input caused `active`; the *first* one in priority order. */
  readonly reason: 'user' | 'system' | 'snooze' | null;
  /** The persisted user switch, on its own. */
  readonly user: boolean;
  /** System state as last read, or null when it could not be detected. */
  readonly system: boolean | null;
  /** Absolute epoch ms when a snooze is running. */
  readonly snoozeUntil: number | null;
}
