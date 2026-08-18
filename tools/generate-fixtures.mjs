/**
 * Genera los fixtures que validan el motor contra el emisor real (esolutions/xml).
 *
 * La cadena que se quiere probar cruza dos lenguajes: el motor calcula en JS, y quien
 * decide si el comprobante es válido es el paquete PHP que arma y valida el XML contra
 * el XSD y las reglas de SUNAT. Un test de cada lado por separado no ve el hueco del
 * medio — que es donde vive el error 3277 ("la sumatoria del total valor de venta de
 * línea no corresponde al total").
 *
 * Por eso los fixtures se COMMITEAN: el lado PHP los lee y los emite sin necesitar node.
 *
 * Regenerar:  node tools/generate-fixtures.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { normalizeItemPricing, calculateTotalsWithGlobals } from '../src/billing.js'
import { toApiDocument } from '../src/adapter.js'

const IGV = 0.18
const OUT = new URL('../tests/fixtures/api/', import.meta.url)
mkdirSync(OUT, { recursive: true })

/** Ítem tal como sale del formulario: precio CON IGV incluido. */
const line = (name, unit_price, quantity, affectation_igv_type_id = '10') => ({
  name, unit_price, quantity, affectation_igv_type_id, unit_type_id: 'NIU',
})

const scenarios = [
  {
    file: 'gravado-simple',
    description: 'Factura gravada simple — el caso realmente emitido y aceptado (B002-5).',
    lines: [line('Servicio de consultoría', 50, 3)],
  },
  {
    file: 'gravado-centavos',
    description: 'Gravado con precio que no divide exacto: verifica que el centavo no se pierda.',
    lines: [line('Repuesto', 33.33, 3)],
  },
  {
    file: 'importes-chicos',
    description: 'Importes muy chicos, donde el IGV redondeado pesa proporcionalmente más.',
    lines: [line('Bolsa', 0.1, 7)],
  },
  {
    file: 'mixto',
    description: 'Gravado + exonerado + inafecto en el mismo comprobante.',
    lines: [line('Producto gravado', 118, 1, '10'), line('Producto exonerado', 50, 2, '20'), line('Producto inafecto', 30, 1, '30')],
  },
  {
    file: 'con-gratuito',
    description: 'Gravado más una línea gratuita (retiro 13): la gratuita no debe sumar al total.',
    lines: [line('Producto vendido', 50, 3, '10'), line('Muestra sin cargo', 100, 1, '13')],
  },
  {
    file: 'exportacion',
    description: 'Exportación (40): sin IGV y en su propio total.',
    lines: [line('Mercadería exportada', 500, 2, '40')],
  },
  {
    file: 'descuento-global-afecta-base',
    description: 'Descuento global que SÍ afecta la base imponible: se reparte dentro de cada línea (obligatorio para NC motivo 04, si no SUNAT rechaza con 3277).',
    lines: [line('Producto', 211, 1)],
    options: { discount_global_id: '02', discount_global_type: '02', discount_global_amount: 10, globalAffectsBase: true },
  },
  {
    file: 'descuento-global-no-afecta-base',
    description: 'Descuento global que NO afecta la base (cat.53 código 02): base e IGV quedan intactos, solo baja el importe a pagar.',
    lines: [line('Producto', 211, 1)],
    options: { discount_global_id: '02', discount_global_type: '02', discount_global_amount: 10, globalAffectsBase: false },
  },
]

const index = []

for (const sc of scenarios) {
  const items = sc.lines.map(l => normalizeItemPricing({ ...l, pricing_mode: 'price' }, IGV))
  const calc = calculateTotalsWithGlobals(items, { igvRate: IGV, ...(sc.options ?? {}) })
  const doc = toApiDocument(calc, {
    igvRate: IGV,
    discountGlobalType: sc.options?.discount_global_type,
    discountGlobalAmount: sc.options?.discount_global_amount,
  })

  // El adaptador devuelve solo importes; la app agrega su metadata. Se replica acá el
  // mínimo que el backend exige (item_data es el snapshot del ítem al emitir).
  doc.items = doc.items.map((it, i) => ({
    ...it,
    item_data: { name: sc.lines[i].name, internal_id: `T${String(i + 1).padStart(3, '0')}` },
  }))

  const fixture = {
    name: sc.file,
    description: sc.description,
    generated_by: 'tools/generate-fixtures.mjs (@esolutions/tax-engine)',
    engine: { igvRate: IGV, options: sc.options ?? {} },
    input: sc.lines,
    payload: doc,
  }

  writeFileSync(new URL(`${sc.file}.json`, OUT), JSON.stringify(fixture, null, 2) + '\n')
  index.push({ file: `${sc.file}.json`, description: sc.description, total: doc.total })
  console.log(`${sc.file.padEnd(34)} total ${String(doc.total).padStart(8)}  igv ${String(doc.total_igv).padStart(7)}  lineas ${doc.items.length}`)
}

writeFileSync(new URL('index.json', OUT), JSON.stringify(index, null, 2) + '\n')
console.log(`\n${index.length} fixtures en tests/fixtures/api/`)
