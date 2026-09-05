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
  it.each([
    resolve(__dirname, '../../../../openapi.json'),
    resolve(__dirname, '../../../../../admin/lib/openapi.json'),
  ])('keeps order DTO schemas aligned in %s', (filePath) => {
    const schemas = readSchemas(filePath);
    expect(schemas.CreateOrderDto.properties?.title?.maxLength).toBe(100);
    expect(schemas.CreateOrderDto.properties?.description?.maxLength).toBe(500);
    expect(schemas.CreateOrderDto.required).toContain('counterpartUsername');
    expect(schemas.CreateOrderLinkDto.properties?.deliveryDeadlineDays?.maximum).toBe(14);
    expect(schemas.UpdateShippingDto.required ?? []).toEqual([]);
    expect(schemas.RejectDeliveryDto.properties?.proofId?.pattern).toBe('^c[a-z0-9]{24}$');
  });
});
