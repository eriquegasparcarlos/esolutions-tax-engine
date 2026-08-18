/**
 * Guard diferencial entre los dos linajes del motor.
 *
 * El paquete arrastra dos implementaciones de distinto origen: `pos.js` (port de
 * functions_2.js de intipos v1) y `billing.js` (reescritura de intipos13, la que
 * emite hoy). Antes de unificarlas hay que saber DÓNDE difieren.
 *
 * Este archivo es el contrato de esa convergencia: el camino principal debe dar
 * exactamente lo mismo por los dos lados, y las divergencias conocidas están
 * enumeradas una por una. Si aparece una nueva, este test la caza.
 */
import { describe, it, expect } from 'vitest'
import { calculateRowItem, calculateTotal } from '../src/pos.js'
import { normalizeItemPricing, calculateTotals } from '../src/billing.js'

const IGV = 0.18

/** Corre el mismo documento por ambos motores y normaliza la forma del resultado. */
function bothEngines(items) {
  const rows = items.map((it, index) => calculateRowItem({ ...it, index }, 18))
  const legacy = calculateTotal({ items: rows })

  const normalized = items.map(it => normalizeItemPricing({ ...it, pricing_mode: 'price' }, IGV))
  const { totalsPre: current } = calculateTotals(normalized, { igvRate: IGV })

  return {
    legacy: { base: legacy.total_value, tax: legacy.total_igv, total: legacy.total },
    current: { base: current.subtotal, tax: current.tax, total: current.total },
  }
}

const line = (unit_price, quantity, affectation_igv_type_id = '10') => ({
  unit_price, quantity, affectation_igv_type_id,
})

describe('los dos linajes coinciden en el camino principal', () => {
  const cases = [
    ['gravado 3 × 50 (caso real B002-5)', [line(50, 3)]],
    ['gravado con centavos 3 × 33.33', [line(33.33, 3)]],
    ['importes chicos 7 × 0.10', [line(0.1, 7)]],
    ['exonerado', [line(100, 1, '20')]],
    ['inafecto', [line(100, 1, '30')]],
    ['exportación', [line(100, 1, '40')]],
    ['gratuito 13', [line(100, 1, '13')]],
    ['mixto 10 + 20 + 30', [line(118, 1, '10'), line(50, 2, '20'), line(30, 1, '30')]],
    ['varias líneas gravadas', [line(19.9, 11), line(7.77, 13), line(250, 2)]],
    ['documento vacío', []],
  ]

  it.each(cases)('%s', (_name, items) => {
    const { legacy, current } = bothEngines(items)
    expect(current.base).toBeCloseTo(legacy.base, 2)
    expect(current.tax).toBeCloseTo(legacy.tax, 2)
    expect(current.total).toBeCloseTo(legacy.total, 2)
  })
})

describe('divergencias conocidas (enumeradas a propósito)', () => {
  /*
  | El catálogo del producto (cat_affectation_igv_types.free = 1) dice que 32–36 son
  | transferencias GRATUITAS. billing.js las clasifica bien; pos.js las cobra.
  | La convergencia debe quedarse con el criterio de billing.js.
  */
  it.each(['32', '33', '34', '35', '36'])('inafecto por retiro %s: pos.js lo cobra, billing.js no', (code) => {
    const { legacy, current } = bothEngines([line(100, 1, code)])
    expect(legacy.base).toBe(100)
    expect(current.base).toBe(0)
  })

  /*
  | 17 es "Gravado – IVAP" (arroz pilado): operación ONEROSA con su propia tasa.
  | Ningún linaje implementa IVAP. En el producto el código está is_active = 0, así
  | que hoy nadie puede elegirlo — por eso no bloquea, pero queda anotado.
  */
  it('IVAP (17): ninguno de los dos lo implementa', () => {
    const { legacy, current } = bothEngines([line(100, 1, '17')])
    expect(legacy.total).toBe(0)
    expect(current.total).toBe(0)
  })
})
