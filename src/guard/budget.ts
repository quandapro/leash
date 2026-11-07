// Budget checks: per key (daily, monthly) and global daily. Day and month boundaries are UTC.
import { startOfDayUtc, startOfMonthUtc, type Key, type Store } from '../db.ts';

export interface BudgetVerdict {
  ok: boolean;
  reason?: string;
  warnings: string[];
}

// Agent-sized amounts need more than cents: $0.0042, not $0.00.
const fmt = (n: number) => (Math.abs(n) < 1 ? `$${n.toFixed(4).replace(/(\.\d\d\d*?)0+$/, '$1')}` : `$${n.toFixed(2)}`);

export function globalDailyLimit(store: Store): number | null {
  const v = Number(store.getSetting('global_daily_usd'));
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function checkBudget(store: Store, key: Key, estimate: number, now: number): BudgetVerdict {
  const warnings: string[] = [];
  const limits: { label: string; limit: number | null; spent: () => number }[] = [
    { label: `daily budget for key "${key.name}"`, limit: key.daily_usd, spent: () => store.keySpendSince(key.id, startOfDayUtc(now)) },
    { label: `monthly budget for key "${key.name}"`, limit: key.monthly_usd, spent: () => store.keySpendSince(key.id, startOfMonthUtc(now)) },
    { label: 'global daily budget', limit: globalDailyLimit(store), spent: () => store.totalSpendSince(startOfDayUtc(now)) },
  ];
  for (const l of limits) {
    if (l.limit === null || l.limit <= 0) continue;
    const spent = l.spent();
    if (spent + estimate > l.limit) {
      return { ok: false, reason: `${l.label} reached: ${fmt(spent)} spent of ${fmt(l.limit)} (this request could cost up to ${fmt(estimate)})`, warnings };
    }
    if (spent >= l.limit * 0.8) warnings.push(`${l.label} at ${Math.round((spent / l.limit) * 100)}%: ${fmt(spent)} of ${fmt(l.limit)}`);
  }
  return { ok: true, warnings };
}
