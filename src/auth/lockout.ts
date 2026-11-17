/**
 * Slows down password guessing on the sign-in page: after too many failures
 * for one login or from one address, further tries are refused for a while.
 * Kept in memory; a restart clears it, which is acceptable.
 */
export class Lockout {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly windowMs = 15 * 60 * 1000,
    private readonly maxPerLogin = 5,
    private readonly maxPerAddress = 20,
    private readonly clock: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.clock() - this.windowMs;
    const kept = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length > 0) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }

  isLocked(login: string, address: string): boolean {
    return (
      this.recent(`login:${login.toLowerCase()}`).length >= this.maxPerLogin ||
      this.recent(`addr:${address}`).length >= this.maxPerAddress
    );
  }

  recordFailure(login: string, address: string): void {
    const t = this.clock();
    for (const key of [`login:${login.toLowerCase()}`, `addr:${address}`]) {
      this.failures.set(key, [...this.recent(key), t]);
    }
    if (this.failures.size > 10_000) {
      for (const key of this.failures.keys()) this.recent(key);
    }
  }

  recordSuccess(login: string): void {
    this.failures.delete(`login:${login.toLowerCase()}`);
  }
}
