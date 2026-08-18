/**
 * Genera los fixtures que validan el motor contra el emisor real (esolutions/xml).
 *
 * La cadena que se quiere probar cruza dos lenguajes: el motor calcula en JS, y quien
 * decide si el comprobante es válido es el paquete PHP que arma y valida el XML contra el
 * XSD y las reglas de SUNAT. Un test de cada lado por separado no ve el hueco del medio —
 * que es donde vive el error 3277 ("la sumatoria del total valor de venta de línea no
 * corresponde al total").
 *
 * Por eso los fixtures se COMMITEAN: el lado PHP los lee y los emite sin necesitar node.
 *
 * Regenerar:  pnpm fixtures
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { calculateDocument } from '../src/api.js'
import { DEFAULT_AFFECTATION_CATALOG } from '../src/catalogs.js'

const IGV = 0.18
const OUT = new URL('../tests/fixtures/api/', import.meta.url)
mkdirSync(OUT, { recursive: true })

const CATALOGS = {
  affectation_igv_types: DEFAULT_AFFECTATION_CATALOG,
  detraction_types: [{ id: '01', code: '001', percentage: 12, minimum_amount: 700 }],
  retention_types: [{ id: '01', code: '01', percentage: 3 }],
}

const line = (name, unit_price, quantity, affectation_igv_type_id = '10', extra = {}) => ({
  name, unit_price, quantity, affectation_igv_type_id, unit_type_id: 'NIU', ...extra,
})

/**
 * Cada escenario es una entrada COMPLETA del motor. El fixture guarda la entrada y la
 * salida, así el lado PHP emite exactamente lo que el motor produjo.
 */
const scenarios = [
  {
    file: 'gravado-simple',
    description: 'Factura gravada simple — el caso realmente emitido y aceptado (B002-5).',
    items: [line('Servicio de consultoría', 50, 3)],
  },
  {
    file: 'gravado-centavos',
    description: 'Precio que no divide exacto: verifica que el centavo no se pierda.',
    items: [line('Repuesto', 33.33, 3)],
  },
  {
    file: 'importes-chicos',
    description: 'Importes muy chicos, donde el IGV redondeado pesa proporcionalmente más.',
    items: [line('Bolsa', 0.1, 7)],
  },
  {
    file: 'mixto',
    description: 'Gravado + exonerado + inafecto en el mismo comprobante.',
    items: [line('Producto gravado', 118, 1, '10'), line('Producto exonerado', 50, 2, '20'), line('Producto inafecto', 30, 1, '30')],
  },
  {
    file: 'con-gratuito',
    description: 'Gravado más una línea gratuita (retiro 13): la gratuita no suma al total.',
    items: [line('Producto vendido', 50, 3, '10'), line('Muestra sin cargo', 100, 1, '13')],
  },
  {
    file: 'exportacion',
    description: 'Exportación (40): sin IGV y en su propio total.',
    items: [line('Mercadería exportada', 500, 2, '40')],
  },
  {
    file: 'descuento-global-afecta-base',
    description: 'Descuento global que SÍ afecta la base: se reparte dentro de cada línea (obligatorio para NC motivo 04, si no SUNAT rechaza con 3277).',
    items: [line('Producto', 211, 1)],
    global_discounts: [{ type: 'percent', value: 10, affects_base: true }],
  },
  {
    file: 'descuento-global-no-afecta-base',
    description: 'Descuento global que NO afecta la base (cat.53 código 02): base e IGV intactos, solo baja el importe a pagar.',
    items: [line('Producto', 211, 1)],
    global_discounts: [{ type: 'percent', value: 10, affects_base: false }],
  },

  // ── Casos que la v1 no cubría ──────────────────────────────────────────────
  {
    file: 'valor-unitario',
    description: 'El usuario trabaja con VALOR unitario (sin IGV) en vez de precio: el IGV se agrega encima.',
    document: { pricing_mode: 'value' },
    items: [
      { name: 'Servicio', quantity: 2, unit_value: 100, unit_type_id: 'ZZ', affectation_igv_type_id: '10' },
    ],
  },
  {
    file: 'moneda-extranjera',
    description: 'Ítem en dólares dentro de un comprobante en soles, con tipo de cambio.',
    document: { exchange_rate: 3.75 },
    items: [line('Equipo importado', 100, 2, '10', { currency_id: 'USD' })],
  },
  {
    file: 'icbper',
    description: 'Impuesto a la bolsa plástica: monto fijo por unidad, ajeno a la base del IGV.',
    document: { icbper_rate: 0.5 },
    items: [line('Producto', 20, 3), line('Bolsa', 0.5, 4, '10', { has_icbper: true })],
  },
  {
    file: 'descuento-por-linea',
    description: 'Descuento aplicado sobre una línea puntual, no sobre el documento.',
    items: [
      line('Producto con descuento', 118, 1, '10', { discounts: [{ type: 'percent', value: 10 }] }),
      line('Producto sin descuento', 50, 2),
    ],
  },
  {
    file: 'con-detraccion',
    description: 'Factura sujeta a detracción: el comprobante no cambia, cambia cuánto recibe el emisor.',
    items: [line('Servicio sujeto a detracción', 1000, 1)],
    detraction: { type_id: '01', payment_method_id: '001', account: '00-123-456789' },
  },
  {
    file: 'con-retencion',
    description: 'Cliente agente de retención: retiene un porcentaje del importe a pagar.',
    items: [line('Servicio', 1000, 1)],
    retention: { type_id: '01' },
  },
]

/** Notas de crédito y débito. El lado PHP emite primero la factura afectada. */
const notes = [
  {
    file: 'nota-credito-anulacion',
    description: 'NC 01 (anulación): refleja los importes del comprobante afectado.',
    document: { document_type_id: '07' },
    note: { type_id: '01', description: 'Anulación de la operación' },
    items: [line('Servicio de consultoría', 50, 3)],
  },
  {
    file: 'nota-credito-descuento-global',
    description: 'NC 04 (descuento global): el ajuste DEBE repartirse dentro de las líneas o SUNAT rechaza con 3277.',
    document: { document_type_id: '07' },
    note: { type_id: '04', description: 'Descuento global sobre la operación' },
    items: [line('Servicio de consultoría', 50, 3)],
    global_discounts: [{ type: 'percent', value: 10, affects_base: true }],
  },
  {
    file: 'nota-debito-intereses',
    description: 'ND 01 (intereses por mora).',
    document: { document_type_id: '08' },
    note: { type_id: '01', description: 'Intereses por mora' },
    items: [line('Interés por mora', 25, 1)],
  },
]

const index = []

for (const sc of [...scenarios, ...notes]) {
  const esNota = ['07', '08'].includes(sc.document?.document_type_id)

  const input = {
    catalogs: CATALOGS,
    document: {
      document_type_id: '01',
      currency_id: 'PEN',
      igv_rate: IGV,
      operation_type_id: '0101',
      ...sc.document,
    },
    items: sc.items,
    ...(sc.global_discounts ? { global_discounts: sc.global_discounts } : {}),
    ...(sc.global_charges ? { global_charges: sc.global_charges } : {}),
    ...(sc.detraction ? { detraction: sc.detraction } : {}),
    ...(sc.retention ? { retention: sc.retention } : {}),
    ...(sc.note
      ? { note: { affected_document_type_id: '01', affected_series: 'F001', affected_number: 1, ...sc.note } }
      : {}),
  }

  const r = calculateDocument(input)

  /*
  | Payload de emisión. La salida de la v2 ya usa los nombres del comprobante, así que es
  | casi una copia; solo se agrega `item_data`, que es el snapshot del ítem y pertenece a
  | la aplicación, no al motor.
  */
  const payload = {
    ...r.totals,
    items: r.lines.map((l, i) => ({
      unit_type_id: l.unit_type_id,
      quantity: l.quantity,
      unit_value: l.unit_value,
      unit_price: l.unit_price,
      affectation_igv_type_id: l.affectation_igv_type_id,
      price_type_id: l.price_type_id,
      total_base_igv: l.total_base_igv,
      percentage_igv: l.percentage_igv,
      total_igv: l.total_igv,
      total_taxes: l.total_taxes,
      total_value: l.total_value,
      total_discount: l.total_discount,
      total_charge: l.total_charge,
      total_icbper: l.total_icbper,
      factor_icbper: l.factor_icbper,
      total: l.total,
      item_data: { name: sc.items[i].name, internal_id: `T${String(i + 1).padStart(3, '0')}` },
    })),
    // `document_discounts` nombra al motivo `discount_id`; el motor lo llama
    // `reason_code` porque es el código del catálogo 53, no un id de la aplicación.
    discounts: r.global_discounts.map((d) => ({
      discount_id: d.reason_code,
      name: 'Descuento global',
      base: d.base, factor: d.factor, amount: d.amount, percentage: d.percentage,
      is_amount: false, type: '02', amount_base: 0,
    })),
    charges: r.global_charges.map((c) => ({
      charge_id: c.reason_code,
      name: 'Cargo global',
      base: c.base, factor: c.factor, amount: c.amount, percentage: c.percentage,
      is_amount: false, type: '02', amount_base: 0,
    })),
  }

  const fixture = {
    name: sc.file,
    description: sc.description,
    generated_by: 'tools/generate-fixtures.mjs (@esolutions/tax-engine v2)',
    kind: esNota ? 'note' : 'document',
    input,
    payload,
    detraction: r.detraction,
    retention: r.retention,
    note: r.note,
  }

  writeFileSync(new URL(`${sc.file}.json`, OUT), JSON.stringify(fixture, null, 2) + '\n')
  index.push({ file: `${sc.file}.json`, kind: fixture.kind, description: sc.description, total: r.totals.total })

  const extra = r.detraction?.applies ? `  detrac ${r.detraction.amount}`
    : r.retention ? `  retenc ${r.retention.amount}` : ''
  console.log(`${sc.file.padEnd(34)} ${fixture.kind.padEnd(9)} total ${String(r.totals.total).padStart(9)}  igv ${String(r.totals.total_igv).padStart(8)}${extra}`)
}

writeFileSync(new URL('index.json', OUT), JSON.stringify(index, null, 2) + '\n')
console.log(`\n${index.length} fixtures en tests/fixtures/api/`)
