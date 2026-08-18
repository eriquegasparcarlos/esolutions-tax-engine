/**
 * Helpers de redondeo, clasificación del Catálogo 07 y descuento global.
 *
 * Los casos de clasificación NO son arbitrarios: se contrastan contra el catálogo
 * `cat_affectation_igv_types` que usa el producto (columna `free`), que es la fuente
 * de verdad real. Ver tests/catalog-07.md.
 */
import { describe, it, expect } from 'vitest'
import {
  round, r2, r4,
  isGravado, isGratuito, isGravadoGratuito,
  sumBy, getAmountFromInputDiscount, calculateDiscountGlobal,
} from '../src/tax-engine.js'

describe('redondeo', () => {
  it('redondea a 2 y 4 decimales', () => {
    expect(r2(10.005)).toBe(10.01)
    expect(r2(0.1 + 0.2)).toBe(0.3)
    expect(r4(1.00005)).toBe(1.0001)
    expect(round(1.23456, 3)).toBe(1.235)
  })

  it('r2 sobre un valor ya redondeado es idempotente', () => {
    expect(r2(r2(127.115))).toBe(r2(127.115))
  })
})

describe('clasificación Catálogo 07', () => {
  it('10 es gravado oneroso y no gratuito', () => {
    expect(isGravado('10')).toBe(true)
    expect(isGratuito('10')).toBe(false)
  })

  it('11–16 son gravados gratuitos (retiros con IGV referencial)', () => {
    for (const c of ['11', '12', '13', '14', '15', '16']) {
      expect(isGravadoGratuito(c), `código ${c}`).toBe(true)
      expect(isGratuito(c), `código ${c}`).toBe(true)
    }
  })

  it('20/30/40 son onerosos sin IGV', () => {
    for (const c of ['20', '30', '40']) expect(isGratuito(c), `código ${c}`).toBe(false)
  })

  it('acepta el código como número además de string', () => {
    expect(isGravado(10)).toBe(true)
    expect(isGratuito(13)).toBe(true)
  })

  /*
  | DIVERGENCIA CONOCIDA con el catálogo del producto.
  |
  | 32–36 son "Inafecto – Retiro por {muestras médicas, convenio colectivo, premio,
  | publicidad}": transferencias GRATUITAS, y así los marca el catálogo (free = 1).
  | Este linaje (port de functions_2.js de v1) los trata como inafecto ONEROSO, o sea
  | los cobraría. El linaje de billing.js los clasifica bien.
  |
  | El test fija el comportamiento actual para que el cambio sea deliberado y visible
  | cuando se unifique la clasificación contra el catálogo.
  */
  it('[bug conocido] 32–36 deberían ser gratuitos y este linaje los da onerosos', () => {
    for (const c of ['32', '33', '34', '35', '36']) {
      expect(isGratuito(c), `código ${c}`).toBe(false)
    }
  })
})

describe('getAmountFromInputDiscount', () => {
  it('usa el monto cuando use_input_amount es true', () => {
    expect(getAmountFromInputDiscount({ use_input_amount: true, amount: 25, percentage: 10 })).toBe(25)
  })

  it('usa el porcentaje cuando no', () => {
    expect(getAmountFromInputDiscount({ amount: 25, percentage: 10 })).toBe(10)
    expect(getAmountFromInputDiscount({ use_input_amount: false, amount: 25, percentage: 10 })).toBe(10)
  })
})

describe('sumBy', () => {
  it('suma la proyección y devuelve 0 en vacío', () => {
    expect(sumBy([{ n: 1 }, { n: 2 }], x => x.n)).toBe(3)
    expect(sumBy([], x => x.n)).toBe(0)
  })
})

describe('calculateDiscountGlobal', () => {
  const form = {
    total_exportation_init: 0, total_exonerated_init: 0, total_unaffected_init: 0,
    total_taxed_init: 178.81, total_plastic_bag_taxes: 0, total_init: 211, total_igv: 32.19,
  }

  it('no toca los totales si está deshabilitado o el monto es 0', () => {
    expect(calculateDiscountGlobal(form, false, '02', 10).total_discount).toBe(0)
    expect(calculateDiscountGlobal(form, true, '02', 0).total_discount).toBe(0)
  })

  it('aplica 10% sobre 211 y deja 189.90', () => {
    const r = calculateDiscountGlobal(form, true, '02', 10)
    expect(r.total).toBe(189.9)
    expect(r.total_discount).toBeCloseTo(21.1, 2)
  })

  it('marca el descuento como afecta-base (cat.53 tipo 02) cuando hay gravado', () => {
    const r = calculateDiscountGlobal(form, true, '02', 10)
    const taxed = r.discounts.find(d => d.discount_type_id === '02')
    expect(taxed).toBeDefined()
    expect(taxed.description).toMatch(/afectan la base imponible/)
  })

  it('convierte monto a porcentaje cuando el tipo no es 02', () => {
    const r = calculateDiscountGlobal(form, true, '01', 21.1)
    expect(r.total).toBeCloseTo(189.9, 2)
    expect(r.discounts[0].is_amount).toBe(true)
  })
})
