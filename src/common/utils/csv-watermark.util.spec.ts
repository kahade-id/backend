import { buildCsvExportWatermark, withCsvExportWatermark } from './csv-watermark.util';

describe('csv-watermark.util (ADM-429)', () => {
  it('builds a watermark line with hashed exporter id and ISO timestamp', () => {
    const line = buildCsvExportWatermark('admin-123', 'admin/users/export');
    expect(line.startsWith('# kahade-export ')).toBe(true);
    expect(line).toContain('source=admin/users/export');
    // 16 hex chars, bukan ID mentah.
    expect(line).toMatch(/exported_by_sha256=[0-9a-f]{16}/);
    expect(line).not.toContain('admin-123');
    expect(line).toMatch(/exported_at=\d{4}-\d{2}-\d{2}T/);
    expect(line.endsWith('\n')).toBe(true);
  });

  it('is deterministic for the same admin (traceable internally)', () => {
    const a = buildCsvExportWatermark('admin-123', 'admin/finance/export');
    const b = buildCsvExportWatermark('admin-123', 'admin/finance/export');
    expect(a.split('exported_at=')[0]).toBe(b.split('exported_at=')[0]);
  });

  it('produces different hashes for different admins', () => {
    const a = buildCsvExportWatermark('admin-1', 's');
    const b = buildCsvExportWatermark('admin-2', 's');
    expect(a).not.toBe(b);
  });

  it('prepends watermark after the BOM when present', () => {
    const csv = '\uFEFFid,name\n1,budi';
    const out = withCsvExportWatermark(csv, 'admin-123', 'admin/users/export');
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out.slice(1).startsWith('# kahade-export ')).toBe(true);
    expect(out).toContain('id,name\n1,budi');
  });

  it('prepends watermark at the very start when no BOM', () => {
    const out = withCsvExportWatermark('a,b\n', 'admin-123', 's');
    expect(out.startsWith('# kahade-export ')).toBe(true);
    expect(out.endsWith('a,b\n')).toBe(true);
  });
});
