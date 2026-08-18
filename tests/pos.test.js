/**
 * Linaje LEGACY (port de functions_2.js de intipos v1). Se conserva porque el POS y
 * hoteles todavía lo apuntan; los tests fijan su comportamiento actual, incluidos
 * los defectos, para que la unificación sea un cambio visible y no un accidente.
 */
import { describe, it, expect } from 'vitest'
import { calculateRowItem, calculateTotal } from '../src/pos.js'

const row = (unit_price, quantity, affectation_igv_type_id = '10', extra = {}) =>
  calculateRowItem({ unit_price, quantity, affectation_igv_type_id, index: 0, ...extra }, 18)

const doc = rows => calculateTotal({ items: rows })

describe('calculateRowItem', () => {
  it('desagrega el IGV de un precio que lo incluye', () => {
    expect(row(50, 3)).toMatchObject({ total_value: 127.12, total_igv: 22.88, total: 150 })
  })

  it('acepta la tasa como 18 o como 0.18', () => {
    const a = calculateRowItem({ unit_price: 50, quantity: 3, affectation_igv_type_id: '10' }, 18)
    const b = calculateRowItem({ unit_price: 50, quantity: 3, affectation_igv_type_id: '10' }, 0.18)
    expect(a.total).toBe(b.total)
    expect(a.total_igv).toBe(b.total_igv)
  })

  it('exonerado e inafecto no generan IGV', () => {
    expect(row(100, 1, '20')).toMatchObject({ total_igv: 0, total: 100 })
    expect(row(100, 1, '30')).toMatchObject({ total_igv: 0, total: 100 })
  })

  it('un gratuito no se cobra y se marca price_type_id 02', () => {
    expect(row(100, 1, '13')).toMatchObject({ price_type_id: '02', unit_value: 0, total: 0 })
  })

  it('cantidad por defecto 1 cuando no viene', () => {
    expect(calculateRowItem({ unit_price: 118, affectation_igv_type_id: '10' }, 18).total).toBe(118)
  })

  it('ICBPER: suma el impuesto a la bolsa por unidad', () => {
    const r = row(10, 2, '10', { has_plastic_bag_taxes: true, amount_plastic_bag_taxes: 0.5 })
    expect(r.total_plastic_bag_taxes).toBe(1)
  })

  /*
  | BUG: el ISC está declarado en la fila (percentage_isc, total_base_isc, total_isc)
  | pero nunca se calcula — `totalIsc` nace en 0 y jamás se reasigna. calculateTotal
  | después agrega un valor que siempre es cero. Un producto afecto a ISC saldría sin
  | ese impuesto. El linaje de billing.js tampoco lo implementa.
  */
  it('[bug conocido] el ISC nunca se calcula, aunque se declare el porcentaje', () => {
    const r = row(100, 1, '10', { has_isc: true, system_isc_type_id: '01', percentage_isc: 10 })
    expect(r.total_isc).toBe(0)
  })
})

describe('calculateTotal', () => {
  it('agrega un documento mixto', () => {
    const t = doc([row(118, 1, '10'), row(50, 2, '20'), row(30, 1, '30')])
    expect(t).toMatchObject({ total_taxed: 100, total_exonerated: 100, total_unaffected: 30, total_igv: 18, total: 248 })
  })

  it('documento vacío da todo en cero', () => {
    expect(doc([])).toMatchObject({ total: 0, total_igv: 0, total_value: 0 })
  })

  /*
  | BUG: para 17 (IVAP) y 32–36 (inafecto por retiro) este linaje deja el documento
  | INTERNAMENTE INCONSISTENTE: acumula 100 en total_value pero el total queda en 0,
  | así que el valor de venta no cuadra con el importe. En el XML sale descuadrado.
  |
  | Causa: calculateRowItem los trata como gratuitos (no están en [10,20,30,40]) y
  | pone total = 0, pero calculateTotal los suma a total_value igual.
  */
  it('[bug conocido] 32 deja total_value sin correspondencia con el total', () => {
    const t = doc([row(100, 1, '32')])
    expect(t.total_value).toBe(100)
    expect(t.total).toBe(0)
  })

  it('[bug conocido] 17 (IVAP) tiene el mismo descuadre', () => {
    const t = doc([row(100, 1, '17')])
    expect(t.total_value).toBe(100)
    expect(t.total).toBe(0)
  })

  it('los totales _init espejan a los finales antes del descuento global', () => {
    const t = doc([row(50, 3)])
    expect(t.total_taxed_init).toBe(t.total_taxed)
    expect(t.total_igv_init).toBe(t.total_igv)
  })
})
