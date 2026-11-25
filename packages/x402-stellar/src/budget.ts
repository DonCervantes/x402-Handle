const STROOPS_PER_USDC = 10_000_000;
const MS_PER_DAY = 86_400_000;

function toStroops(usdc: number): number {
  if (!Number.isFinite(usdc) || usdc < 0) {
    throw new Error(`DailySpendBudget: invalid USDC amount ${usdc}`);
  }
  return Math.round(usdc * STROOPS_PER_USDC);
}

export interface DailySpendBudgetOpts {
  capUsdc: number;
  now?: () => number;
}

export class DailySpendBudget {
  private readonly capStroops: number;
  private readonly now: () => number;
  private windowDay: number;
  private spentStroops = 0;

  constructor(opts: DailySpendBudgetOpts) {
    this.capStroops = toStroops(opts.capUsdc);
    this.now = opts.now ?? Date.now;
    this.windowDay = this.currentDay();
  }

  private currentDay(): number {
    return Math.floor(this.now() / MS_PER_DAY);
  }

  private rollWindowIfNeeded(): void {
    const today = this.currentDay();
    if (today !== this.windowDay) {
      this.windowDay = today;
      this.spentStroops = 0;
    }
  }

  get spentUsdc(): number {
    this.rollWindowIfNeeded();
    return this.spentStroops / STROOPS_PER_USDC;
  }

  get remainingUsdc(): number {
    this.rollWindowIfNeeded();
    return Math.max(0, this.capStroops - this.spentStroops) / STROOPS_PER_USDC;
  }

  /**
   * Reserves `amountUsdc` against the current UTC day's cap before signing.
   * Returns a release callback to undo the reservation if submission fails.
   */
  reserve(amountUsdc: number): () => void {
    this.rollWindowIfNeeded();
    const amountStroops = toStroops(amountUsdc);
    if (this.spentStroops + amountStroops > this.capStroops) {
      const cap = this.capStroops / STROOPS_PER_USDC;
      const spent = this.spentStroops / STROOPS_PER_USDC;
      throw new Error(
        `x402Pay: challenge amount ${amountUsdc} exceeds dailyCapUsdc ${cap} (spentToday=${spent})`,
      );
    }
    this.spentStroops += amountStroops;
    const reservedDay = this.windowDay;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.windowDay === reservedDay) {
        this.spentStroops = Math.max(0, this.spentStroops - amountStroops);
      }
    };
  }
}
