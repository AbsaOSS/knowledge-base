// Token buckets: one per client, plus a global one that only backs them up, so one caller
// cannot starve the rest.

export interface RateLimits {
  /** Sustained requests per second per client. */
  rps: number;
  burst: number;
  globalRps: number;
  globalBurst: number;
  /** Clients tracked at once; the least recently seen is forgotten first. */
  maxClients: number;
}

class TokenBucket {
  private tokens: number;
  private previous = Date.now();
  private readonly rps: number;
  private readonly burst: number;

  constructor(rps: number, burst: number) {
    this.rps = rps;
    this.burst = burst;
    this.tokens = burst;
  }

  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.previous) / 1000) * this.rps);
    this.previous = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export class RateLimiter {
  private readonly limits: RateLimits;
  private readonly global: TokenBucket;
  /** Insertion order is recency order: a hit re-inserts its client at the end. */
  private readonly clients = new Map<string, TokenBucket>();

  constructor(limits: RateLimits) {
    this.limits = limits;
    this.global = new TokenBucket(limits.globalRps, limits.globalBurst);
  }

  allow(client: string, now = Date.now()): boolean {
    let own = this.clients.get(client);
    if (own) {
      this.clients.delete(client);
    } else {
      own = new TokenBucket(this.limits.rps, this.limits.burst);
      if (this.clients.size >= this.limits.maxClients) {
        const oldest = this.clients.keys().next().value;
        if (oldest !== undefined) this.clients.delete(oldest);
      }
    }
    this.clients.set(client, own);
    return own.take(now) && this.global.take(now);
  }
}
