/**
 * A one-method holder for values that cannot be constructed first.
 *
 * The application has exactly two initialization cycles, both of them benign
 * and both solved here rather than with `undefined as unknown as T`:
 *
 *  - `WindowManager` needs "is the app quitting?", which only `AppLifecycle`
 *    knows, but the lifecycle needs the window manager;
 *  - the tray needs the diagnostics snapshot, which needs the tray.
 *
 * A `Late<T>` makes "will be filled in during composition, before anything can
 * call it" explicit in the type system: `get()` returns `T | null`, so every use
 * site has to handle the (impossible, but checked) pre-binding case.
 */
export class Late<T extends object> {
  #value: T | null = null;

  set(value: T): void {
    if (this.#value !== null) throw new Error('Late: already bound');
    this.#value = value;
  }

  get(): T | null {
    return this.#value;
  }

  /** For call sites where a missing binding is a programming error. */
  require(label: string): T {
    if (this.#value === null) throw new Error(`Late: ${label} was used before it was bound`);
    return this.#value;
  }

  get bound(): boolean {
    return this.#value !== null;
  }
}
