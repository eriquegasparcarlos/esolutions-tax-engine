/**
 * Adaptador motor → contrato de emisión.
 *
 * El caso que motivó extraer esto: con el mapeo incompleto el documento salía con el
 * total correcto pero el IGV de cada LÍNEA en cero. Como el XML se arma línea por línea,
 * SUNAT habría recibido los tributos descuadrados. Por eso hay un test explícito de que
 * las líneas cuadran con la cabecera.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { normalizeItemPricing, calculateTotalsWithGlobals } from '../src/billing.js'
import { toApiLine, toApiTotals, toApiDiscounts, toApiDocument } from '../src/adapter.js'

const IGV = 0.18
const calc = (lines, options = {}) => calculateTotalsWithGlobals(
  lines.map(l => normalizeItemPricing({ ...l, pricing_mode: 'price' }, IGV)),
  { igvRate: IGV, ...options },
)
const line = (unit_price, quantity, affectation_igv_type_id = '10') =>
  ({ unit_price, quantity, affectation_igv_type_id, unit_type_id: 'NIU' })

describe('toApiLine', () => {
  it('traduce base e impuesto a los nombres del comprobante', () => {
    const [l] = calc([line(50, 3)]).items
    expect(toApiLine(l, { igvRate: IGV })).toMatchObject({
      total_value: 127.12, total_base_igv: 127.12, total_igv: 22.88,
      total_taxes: 22.88, percentage_igv: 18, price_type_id: '01',
    })
  })

  /* La regresión concreta que hubo: IGV de línea en cero con total correcto. */
  it('el IGV de la línea NUNCA queda en cero si la línea es gravada', () => {
    for (const [p, q] of [[50, 3], [33.33, 3], [0.1, 7], [211, 1]]) {
      const [l] = calc([line(p, q)]).items
      expect(toApiLine(l, { igvRate: IGV }).total_igv, `${q} × ${p}`).toBeGreaterThan(0)
    }
  })

  it('una línea no gravada no declara base ni porcentaje de IGV', () => {
    for (const code of ['20', '30', '40']) {
      const [l] = calc([line(100, 1, code)]).items
      expect(toApiLine(l, { igvRate: IGV }), `código ${code}`).toMatchObject({
        total_base_igv: 0, percentage_igv: 0, total_igv: 0,
      })
    }
  })

  it('una línea gratuita se marca con price_type_id 02', () => {
    const [l] = calc([line(100, 1, '13')]).items
    expect(toApiLine(l, { igvRate: IGV }).price_type_id).toBe('02')
  })

  it('respeta una tasa de IGV distinta de 18%', () => {
    const items = [normalizeItemPricing({ unit_price: 110, quantity: 1, affectation_igv_type_id: '10', pricing_mode: 'price' }, 0.1)]
    const [l] = calculateTotalsWithGlobals(items, { igvRate: 0.1 }).items
    expect(toApiLine(l, { igvRate: 0.1 }).percentage_igv).toBe(10)
  })
})

describe('toApiTotals', () => {
  it('mapea el subtotal del motor a total_value y el impuesto a total_igv', () => {
    expect(toApiTotals(calc([line(50, 3)]))).toMatchObject({
      total_value: 127.12, subtotal: 127.12, total_igv: 22.88, total: 150, total_pay: 150,
    })
  })

  it('separa los totales por afectación', () => {
    expect(toApiTotals(calc([line(118, 1, '10'), line(50, 2, '20'), line(30, 1, '30')]))).toMatchObject({
      total_taxed: 100, total_exonerated: 100, total_unaffected: 30, total_igv: 18, total: 248,
    })
  })
})

describe('cuadre línea ↔ cabecera (lo que valida SUNAT)', () => {
  const cases = [
    ['gravado simple', [line(50, 3)], {}],
    ['centavos', [line(33.33, 3)], {}],
    ['mixto', [line(118, 1, '10'), line(50, 2, '20'), line(30, 1, '30')], {}],
    ['con gratuito', [line(50, 3, '10'), line(100, 1, '13')], {}],
    ['descuento global afecta base', [line(211, 1)],
      { discount_global_id: '02', discount_global_type: '02', discount_global_amount: 10, globalAffectsBase: true }],
  ]

  it.each(cases)('%s: la suma de las líneas da el total del documento', (_n, lines, options) => {
    const doc = toApiDocument(calc(lines, options), { igvRate: IGV, ...options })
    const suma = doc.items.reduce((a, i) => a + i.total, 0)
    expect(Number(suma.toFixed(2))).toBeCloseTo(doc.total, 2)
  })

  it.each(cases)('%s: la suma del IGV de las líneas da el IGV del documento', (_n, lines, options) => {
    const doc = toApiDocument(calc(lines, options), { igvRate: IGV, ...options })
    const suma = doc.items.reduce((a, i) => a + i.total_igv, 0)
    expect(Number(suma.toFixed(2))).toBeCloseTo(doc.total_igv, 2)
  })
})

describe('toApiDiscounts', () => {
  const opts = { discount_global_id: '02', discount_global_type: '02', discount_global_amount: 10, globalAffectsBase: true }

  it('emite la fila del descuento global cuando lo hay', () => {
    const rows = toApiDiscounts(calc([line(211, 1)], opts), { discountGlobalType: '02', discountGlobalAmount: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ discount_id: '02', percentage: 10, is_amount: false })
  })

  it('sin descuento global no emite filas', () => {
    expect(toApiDiscounts(calc([line(211, 1)]), {})).toEqual([])
  })
})

/*
| Los fixtures se commitean porque los lee el test de integración del lado PHP, que valida
| el XML contra el XSD y las reglas de SUNAT sin necesitar node. Este guard evita que
| queden desincronizados del motor: si alguien cambia el cálculo y no regenera, salta acá
| en vez de aparecer como un rechazo de SUNAT.
*/
describe('fixtures sincronizados con el motor', () => {
  const dir = new URL('./fixtures/api/', import.meta.url)
  const files = readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'index.json')

  it('hay fixtures generados', () => expect(files.length).toBeGreaterThan(0))

  it.each(files)('%s reproduce exactamente lo que da el motor hoy', (file) => {
    const fx = JSON.parse(readFileSync(new URL(file, dir), 'utf8'))
    const options = fx.engine.options ?? {}
    const doc = toApiDocument(calc(fx.input, options), {
      igvRate: fx.engine.igvRate,
      discountGlobalType: options.discount_global_type,
      discountGlobalAmount: options.discount_global_amount,
    })

    // El fixture agrega item_data (metadata de la app); se compara solo lo fiscal.
    const stripped = { ...fx.payload, items: fx.payload.items.map(({ item_data, ...rest }) => rest) }
    expect(stripped).toEqual(doc)
  })
})
