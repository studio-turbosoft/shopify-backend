/**
 * In-memory map whose entries expire after `ttlMs`. Per process only: with several server
 * instances each has its own copy (fine for this single-instance app).
 */
export class TtlMap<K, V> {
  private readonly entries = new Map<K, { value: V; expires: number }>();

  constructor(
    private readonly ttlMs: number,
    /** Oldest entries are dropped beyond this many, so memory stays bounded. */
    private readonly maxSize = 10_000,
  ) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  set(key: K, value: V): void {
    this.entries.delete(key); // re-insert so insertion order = age
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
    this.prune();
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  private prune() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxSize && entry.expires > now) break;
      this.entries.delete(key);
    }
  }
}
