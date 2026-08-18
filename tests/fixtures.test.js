/**
 * Guard de sincronía de los fixtures.
 *
 * Los fixtures se commitean porque los lee el test de integración del lado PHP, que valida
 * el XML contra el XSD y las reglas de SUNAT sin necesitar node. Este guard evita que
 * queden desfasados del motor: si alguien cambia el cálculo y no corre `pnpm fixtures`,
 * salta acá en vez de aparecer como un rechazo de SUNAT.
 *
 * Como el fixture guarda la ENTRADA completa, la comprobación es directa: se vuelve a
 * calcular y se compara con la salida guardada.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { calculateDocument } from '../src/api.js'

const dir = new URL('./fixtures/api/', import.meta.url)
const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json')

describe('fixtures sincronizados con el motor', () => {
  it('hay fixtures generados', () => expect(files.length).toBeGreaterThan(0))

  it.each(files)('%s reproduce lo que da el motor hoy', (file) => {
    const fx = JSON.parse(readFileSync(new URL(file, dir), 'utf8'))
    const r = calculateDocument(fx.input)

    // El payload es los totales MÁS items/discounts/charges, así que se compara el
    // subconjunto de totales y las líneas aparte.
    const { items, discounts, charges, ...totales } = fx.payload
    expect(r.totals).toEqual(totales)

    expect(r.lines).toHaveLength(items.length)
    r.lines.forEach((l, i) => {
      expect(l.total, `${file} línea ${i}`).toBe(items[i].total)
      expect(l.total_igv, `${file} línea ${i}`).toBe(items[i].total_igv)
    })
  })

  /*
  | Regla 3277 de SUNAT: la suma de las líneas tiene que cuadrar con la cabecera.
  |
  | "Cuadrar" depende de si el descuento global afecta la base:
  |   · afecta base  → el ajuste ya está repartido DENTRO de cada línea, así que las
  |     líneas suman el total final. Es lo que exige la nota de crédito motivo 04.
  |   · no afecta base (cat.53 código 02) → las líneas conservan su importe original y
  |     la diferencia la explica el AllowanceCharge del documento. Sumarlas contra el
  |     total final daría distinto, y está bien que así sea.
  */
  it.each(files)('%s: las líneas cuadran con la cabecera (regla 3277)', (file) => {
    const fx = JSON.parse(readFileSync(new URL(file, dir), 'utf8'))
    const { items } = fx.payload
    if (items.length === 0) return

    const noAfectanBase = (fx.input.global_discounts ?? [])
      .filter((d) => d.affects_base === false).length > 0

    const suma = items.reduce((a, i) => a + i.total, 0)
    const esperado = noAfectanBase ? fx.payload.total + fx.payload.total_discount : fx.payload.total

    expect(Number(suma.toFixed(2))).toBeCloseTo(esperado, 2)
  })
})
