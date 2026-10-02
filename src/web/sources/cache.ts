/** Short-lived coalescing cache; failed refreshes remain explicit failures. */
export class CatalogCache<T> {
  private value: T | null = null;
  private until = 0;
  private pending: Promise<T> | null = null;

  /** Store the narrow loader and optional clock for tests. */
  constructor(private readonly load: () => Promise<T>, private readonly now: () => number = Date.now) {}

  /** Share concurrent loads and reuse a successful result for sixty seconds. */
  async get(): Promise<T> {
    if (this.value !== null && this.until > this.now()) return this.value;
    if (this.pending) return this.pending;
    this.pending = this.load().then((value) => { this.value = value; this.until = this.now() + 60000; return value; });
    try { return await this.pending; } finally { this.pending = null; }
  }
}
