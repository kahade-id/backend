import { buildSortedTimeline } from './admin-finance.service';
import { maskSecretsDeep, toInitials } from './finance-secrets.util';

describe('buildSortedTimeline', () => {
  it('mengurutkan event menaik berdasarkan waktu', () => {
    const t1 = new Date('2026-09-26T10:00:00Z');
    const t2 = new Date('2026-09-26T10:05:00Z');
    const t3 = new Date('2026-09-26T10:10:00Z');
    const events = buildSortedTimeline([
      { at: t3, kind: 'LEDGER', label: 'selesai' },
      { at: t1, kind: 'LEDGER', label: 'dibuat' },
      { at: t2, kind: 'WEBHOOK', label: 'webhook' },
    ]);
    expect(events.map((e) => e.label)).toEqual(['dibuat', 'webhook', 'selesai']);
  });

  it('membuang event tanpa timestamp', () => {
    const events = buildSortedTimeline([
      { at: null, kind: 'PROVIDER', label: 'tanpa waktu' },
      { at: new Date('2026-09-26T10:00:00Z'), kind: 'LEDGER', label: 'dibuat' },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].label).toBe('dibuat');
  });

  it('tie-break timestamp sama memakai kind alfabetis (deterministik)', () => {
    const t = new Date('2026-09-26T10:00:00Z');
    const events = buildSortedTimeline([
      { at: t, kind: 'WEBHOOK', label: 'w' },
      { at: t, kind: 'LEDGER', label: 'l' },
    ]);
    expect(events.map((e) => e.kind)).toEqual(['LEDGER', 'WEBHOOK']);
  });

  it('mengembalikan array kosong untuk input kosong', () => {
    expect(buildSortedTimeline([])).toEqual([]);
  });
});

describe('maskSecretsDeep', () => {
  it('memask kunci secret di semua level', () => {
    const input = {
      order_id: 'ORD-123',
      server_key: 'SK-abcdef123456',
      nested: { apiKey: 'key-xyz-999', amount: 100 },
      list: [{ signature: 'sig-abc' }, { note: 'ok' }],
    };
    const out = maskSecretsDeep(input) as Record<string, unknown>;
    expect(out.order_id).toBe('ORD-123');
    expect(out.server_key).toBe('****3456');
    expect((out.nested as Record<string, unknown>).apiKey).toBe('****-999');
    expect((out.nested as Record<string, unknown>).amount).toBe(100);
    const list = out.list as Array<Record<string, unknown>>;
    expect(list[0].signature).toBe('****');
    expect(list[1].note).toBe('ok');
  });

  it('memask snap token & client key', () => {
    const out = maskSecretsDeep({ midtransToken: 'tok-1234567890', client_key: 'ck-abcdef' }) as Record<string, unknown>;
    expect(String(out.midtransToken)).toMatch(/^\*\*\*\*/);
    expect(String(out.client_key)).toMatch(/^\*\*\*\*/);
  });

  it('tidak mengubah nilai non-secret', () => {
    expect(maskSecretsDeep({ a: 1, b: 'x', c: null })).toEqual({ a: 1, b: 'x', c: null });
  });
});

describe('toInitials', () => {
  it('mengambil inisial depan-belakang', () => {
    expect(toInitials('Budi Santoso')).toBe('BS');
    expect(toInitials('Aisyah')).toBe('A');
  });

  it('mengembalikan ?? untuk nama kosong', () => {
    expect(toInitials(null)).toBe('??');
    expect(toInitials('   ')).toBe('??');
  });
});
