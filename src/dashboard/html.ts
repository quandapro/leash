// Auto-escaping HTML templates. Every interpolated value is escaped unless it is already Safe.

export class Safe {
  value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function esc(v: unknown): string {
  return String(v).replace(/[&<>"'`]/g, (c) => ESC[c]!);
}

function render(v: unknown): string {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Safe) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Safe {
  let out = strings[0]!;
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1]!;
  return new Safe(out);
}

export const usd = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return '—';
  // Under a dollar, show up to 4 decimals so agent-sized amounts are exact ($0.0079, $0.0412, $0.50).
  if (Math.abs(n) < 1) return `$${n.toFixed(4).replace(/(\.\d\d\d*?)0+$/, '$1')}`;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export const int = (n: number): string => n.toLocaleString('en-US');

export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const when = (ts: number): string => new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
