import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type SchemaMap = Record<string, {
  properties?: Record<string, { maxLength?: number; maximum?: number; pattern?: string }>;
  required?: string[];
}>;

function readSchemas(filePath: string): SchemaMap {
  const document = JSON.parse(readFileSync(filePath, 'utf8')) as { components: { schemas: SchemaMap } };
  return document.components.schemas;
}

describe('Escrow order lifecycle OpenAPI artifacts', () => {
  // AUDIT-2: this spec previously also read `../../../../../admin/lib/openapi.json` —
  // a file that lives in a *different repository* (the admin web app). In a standalone
  // backend checkout (and therefore in CI) the path never exists, so the suite failed
  // with ENOENT even though the backend contract itself was fine. The backend repo can
  // only guarantee its own artifact; the admin copy is checked in that repo.
  it('keeps order DTO schemas aligned in the backend openapi.json', () => {
    const filePath = resolve(__dirname, '../../../../openapi.json');
    const schemas = readSchemas(filePath);
    expect(schemas.CreateOrderDto.properties?.title?.maxLength).toBe(100);
    expect(schemas.CreateOrderDto.properties?.description?.maxLength).toBe(500);
    expect(schemas.CreateOrderDto.required).toContain('counterpartUsername');
    expect(schemas.CreateOrderLinkDto.properties?.deliveryDeadlineDays?.maximum).toBe(14);
    expect(schemas.UpdateShippingDto.required ?? []).toEqual([]);
    expect(schemas.RejectDeliveryDto.properties?.proofId?.pattern).toBe('^c[a-z0-9]{24}$');
  });
});
