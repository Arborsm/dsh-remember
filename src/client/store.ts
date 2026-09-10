/** Minimal observable snapshot store (useSyncExternalStore-compatible). */
export class SnapshotStore<S> {
  private snapshot: S
  private readonly listeners = new Set<() => void>()

  constructor(initial: S) {
    this.snapshot = initial
  }

  getSnapshot = (): S => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  set(next: S): void {
    if (Object.is(next, this.snapshot)) return
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}
