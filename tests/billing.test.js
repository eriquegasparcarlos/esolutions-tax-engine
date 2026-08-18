/**
 * Motor de totales (linaje intipos13 / "peru_billing_totals_all"). Es el que emite
 * los comprobantes reales, así que estos son tests de CARACTERIZACIÓN: fijan los
 * números que hoy se están mandando a SUNAT. Si uno se rompe, cambió la plata.
 *
 * El caso base no es inventado: es la factura B002-5 emitida y aceptada.
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeItemPricing, projectItemToDocCurrency,
  calculateTotals, calculateTotalsWithGlobals, buildBackendPayload,
} from '../src/billing.js'

const IGV = 0.18

/** Un ítem tal como lo manda el formulario: precio con IGV incluido. */
const priced = (unit_price, quantity, affectation_igv_type_id = '10', extra = {}) =>
  normalizeItemPricing({ unit_price, quantity, affectation_igv_type_id, pricing_mode: 'price', ...extra }, IGV)

const totalsOf = (items, options = {}) =>
  calculateTotalsWithGlobals(items, { igvRate: IGV, ...options }).totals

describe('caso real emitido (B002-5)', () => {
  it('3 × 50.00 con IGV incluido → 127.12 + 22.88 = 150.00', () => {
    const r = calculateTotalsWithGlobals([priced(50, 3)], { igvRate: IGV })
    expect(r.totals).toMatchObject({ subtotal: 127.12, tax: 22.88, total: 150 })
  })

  it('la línea cuadra con el documento (SUNAT valida ambos)', () => {
    const r = calculateTotalsWithGlobals([priced(50, 3)], { igvRate: IGV })
    const line = r.items[0]
    expect(line.base).toBe(127.12)
    expect(line.tax).toBe(22.88)
    expect(line.total).toBe(150)
    expect(line.category).toBe('taxed')
    expect(line.base + line.tax).toBeCloseTo(r.totals.total, 2)
  })
})

describe('afectaciones', () => {
  it('exonerado (20) e inafecto (30) no generan IGV', () => {
    expect(totalsOf([priced(100, 1, '20')])).toMatchObject({ total_exonerated: 100, tax: 0, total: 100 })
    expect(totalsOf([priced(100, 1, '30')])).toMatchObject({ total_unaffected: 100, tax: 0, total: 100 })
  })

  it('exportación (40) va a su propio total, sin IGV', () => {
    expect(totalsOf([priced(100, 1, '40')])).toMatchObject({ total_exportation: 100, tax: 0 })
  })

  it('gratuito (13) no se cobra: total 0 y valor referencial aparte', () => {
    const t = totalsOf([priced(100, 1, '13')])
    expect(t.total).toBe(0)
    expect(t.subtotal).toBe(0)
    expect(t.total_free_ref).toBeGreaterThan(0)
  })

  it('un gratuito no contamina el total de los onerosos', () => {
    const t = totalsOf([priced(50, 3), priced(100, 1, '13')])
    expect(t.total).toBe(150)
  })

  it('documento mixto 10 + 20 + 30', () => {
    const t = totalsOf([priced(118, 1, '10'), priced(50, 2, '20'), priced(30, 1, '30')])
    expect(t).toMatchObject({ subtotal: 230, tax: 18, total: 248 })
  })
})

describe('precisión', () => {
  it('3 × 33.33 no pierde el centavo', () => {
    expect(totalsOf([priced(33.33, 3)])).toMatchObject({ subtotal: 84.74, tax: 15.25, total: 99.99 })
  })

  it('importes chicos: 7 × 0.10', () => {
    expect(totalsOf([priced(0.1, 7)])).toMatchObject({ subtotal: 0.59, tax: 0.11, total: 0.7 })
  })

  it('el total respeta el precio que ve el usuario (reconciliación anti-centavo)', () => {
    for (const [p, q] of [[50, 3], [33.33, 3], [0.1, 7], [19.9, 11], [7.77, 13]]) {
      expect(totalsOf([priced(p, q)]).total, `${q} × ${p}`).toBe(Number((p * q).toFixed(2)))
    }
  })
})

describe('proyección de moneda', () => {
  it('un ítem en USD dentro de un documento en PEN se convierte al tipo de cambio', () => {
    const it = projectItemToDocCurrency(priced(100, 1, '10', { currency_id: 'USD' }), 'PEN', 3.75, IGV)
    expect(it.unit_price).toBe(375)
    expect(it.currency_id).toBe('PEN')
  })

  it('sin cambio de moneda no toca el precio', () => {
    const it = projectItemToDocCurrency(priced(100, 1, '10', { currency_id: 'PEN' }), 'PEN', 3.75, IGV)
    expect(it.unit_price).toBe(100)
  })

  it('un tipo de cambio inválido no rompe ni distorsiona', () => {
    for (const rate of [0, null, undefined, -1]) {
      const it = projectItemToDocCurrency(priced(100, 1, '10', { currency_id: 'USD' }), 'PEN', rate, IGV)
      expect(it.unit_price, `rate=${rate}`).toBe(100)
    }
  })
})

describe('descuento global', () => {
  const base = () => [priced(211, 1)]

  it('10% sobre 211 da 189.90 exacto', () => {
    const t = totalsOf(base(), { discount_global_id: '02', discount_global_type: '02', discount_global_amount: 10 })
    expect(t.total).toBe(189.9)
  })

  it('cuando afecta base, el IGV baja con ella (NC motivo 04)', () => {
    const t = totalsOf(base(), { discount_global_id: '02', discount_global_type: '02', discount_global_amount: 10 })
    expect(t.taxable_base).toBeLessThan(178.81)
    expect(t.tax).toBeLessThan(32.19)
    expect(t.taxable_base + t.tax).toBeCloseTo(t.total, 2)
  })

  it('cuando NO afecta base, base e IGV quedan intactos y solo baja el total', () => {
    const t = totalsOf(base(), {
      discount_global_id: '02', discount_global_type: '02', discount_global_amount: 10,
      globalAffectsBase: false,
    })
    expect(t.total).toBe(189.9)
    expect(t.taxable_base).toBe(178.81)
    expect(t.tax).toBe(32.19)
  })

  it('sin globales el resultado es idéntico al cálculo simple', () => {
    expect(totalsOf(base()).total).toBe(211)
  })

  /*
  | BUG: el guard de entrada acepta {id, amount} pero pushGlobal() exige además `type`
  | y, si falta, descarta el descuento sin avisar. El usuario ve el descuento en
  | pantalla y el comprobante sale por el total completo.
  |
  | Se fija el comportamiento actual; el arreglo va con la unificación de la API.
  */
  it('[bug conocido] sin discount_global_type el descuento se ignora en silencio', () => {
    const t = totalsOf(base(), { discount_global_id: '02', discount_global_amount: 10 })
    expect(t.total).toBe(211)
  })
})

describe('buildBackendPayload', () => {
  const payload = () => buildBackendPayload(calculateTotalsWithGlobals([priced(50, 3)], { igvRate: IGV }))

  it('expone items, totals y los arreglos de cat.53/55', () => {
    const p = payload()
    expect(p.items).toHaveLength(1)
    expect(p.totals.total).toBe(150)
    expect(p.document_allowances).toEqual([])
    expect(p.document_charges).toEqual([])
  })

  it('no filtra los campos internos de precisión', () => {
    const keys = Object.keys(payload().items[0])
    for (const k of ['_taxScaled', '_totalScaled', '_taxResidualScaled']) {
      expect(keys, `no debe exponer ${k}`).not.toContain(k)
    }
  })
})

describe('bordes', () => {
  it('documento vacío da todo en cero', () => {
    expect(totalsOf([])).toMatchObject({ subtotal: 0, tax: 0, total: 0 })
  })

  it('cantidad 0 no aporta', () => {
    expect(totalsOf([priced(50, 0)]).total).toBe(0)
  })

  it('respeta una tasa de IGV distinta a 18%', () => {
    const items = [normalizeItemPricing({ unit_price: 110, quantity: 1, affectation_igv_type_id: '10', pricing_mode: 'price' }, 0.10)]
    const t = calculateTotalsWithGlobals(items, { igvRate: 0.10 }).totals
    expect(t).toMatchObject({ subtotal: 100, tax: 10, total: 110 })
  })
})
