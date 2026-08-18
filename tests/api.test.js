/**
 * API v2: la caja negra. Se envían parámetros e ítems, se recibe todo calculado.
 */
import { describe, it, expect } from 'vitest'
import { calculateDocument, calculateNote } from '../src/api.js'
import { DEFAULT_AFFECTATION_CATALOG } from '../src/catalogs.js'
import { ValidationError } from '../src/errors.js'

const CAT = { affectation_igv_types: DEFAULT_AFFECTATION_CATALOG }

/** Documento mínimo válido; cada test cambia solo lo suyo. */
const doc = (over = {}) => ({
  catalogs: CAT,
  document: { document_type_id: '01', currency_id: 'PEN', igv_rate: 0.18, ...over.document },
  items: over.items ?? [item()],
  ...Object.fromEntries(Object.entries(over).filter(([k]) => !['document', 'items'].includes(k))),
})

const item = (over = {}) => ({
  name: 'Producto',
  quantity: 3,
  unit_price: 50,
  unit_type_id: 'NIU',
  affectation_igv_type_id: '10',
  ...over,
})

describe('cálculo base', () => {
  it('precio con IGV incluido: 3 × 50 → 127.12 + 22.88 = 150', () => {
    const r = calculateDocument(doc())
    expect(r.totals).toMatchObject({ total_value: 127.12, total_igv: 22.88, total: 150, total_pay: 150 })
    expect(r.lines[0]).toMatchObject({ total_base_igv: 127.12, total_igv: 22.88, total: 150, percentage_igv: 18 })
  })

  it('la suma de las líneas da el total (regla 3277 de SUNAT)', () => {
    const r = calculateDocument(doc({ items: [item(), item({ unit_price: 33.33 }), item({ affectation_igv_type_id: '20' })] }))
    const suma = r.lines.reduce((a, l) => a + l.total, 0)
    expect(Number(suma.toFixed(2))).toBeCloseTo(r.totals.total, 2)
  })
})

describe('valor unitario en vez de precio unitario', () => {
  it("pricing_mode 'value': el IGV se AGREGA sobre el valor", () => {
    const r = calculateDocument(
      doc({ document: { pricing_mode: 'value' }, items: [item({ unit_price: undefined, unit_value: 100, quantity: 1 })] }),
    )
    expect(r.totals).toMatchObject({ total_value: 100, total_igv: 18, total: 118 })
  })

  it('se puede fijar por ítem, sobreescribiendo al documento', () => {
    const r = calculateDocument(
      doc({
        document: { pricing_mode: 'value' },
        items: [
          item({ unit_price: undefined, unit_value: 100, quantity: 1 }),
          item({ pricing_mode: 'price', unit_price: 118, quantity: 1 }),
        ],
      }),
    )
    // Las dos líneas describen lo mismo por caminos distintos: 100 + 18.
    expect(r.lines[0].total).toBe(118)
    expect(r.lines[1].total).toBe(118)
    expect(r.totals.total).toBe(236)
  })

  it('exige el campo que corresponde al modo declarado', () => {
    expect(() =>
      calculateDocument(doc({ document: { pricing_mode: 'value' }, items: [item()] })),
    ).toThrow(ValidationError)
  })
})

describe('moneda y tipo de cambio (reversibles)', () => {
  const enUsd = (rate) =>
    calculateDocument(
      doc({
        document: { currency_id: 'PEN', exchange_rate: rate },
        items: [item({ currency_id: 'USD', unit_price: 100, quantity: 1 })],
      }),
    )

  it('convierte el ítem a la moneda del comprobante', () => {
    expect(enUsd(3.75).lines[0].unit_price).toBe(375)
  })

  /*
  | El punto central del diseño: el motor deriva SIEMPRE de los valores originales, así
  | que corregir el tipo de cambio y volver atrás recupera exactamente los importes
  | iniciales. Si reescribiera los ítems en cada pasada, el redondeo se iría acumulando.
  */
  it('cambiar el tipo de cambio y volver recupera los valores iniciales', () => {
    const inicial = enUsd(3.75)
    enUsd(3.9)
    enUsd(4.12)
    const vuelta = enUsd(3.75)
    expect(vuelta.totals).toEqual(inicial.totals)
    expect(vuelta.lines[0].unit_price).toBe(inicial.lines[0].unit_price)
  })

  it('cambiar la moneda del comprobante y volver también', () => {
    const params = (currency) =>
      doc({
        document: { currency_id: currency, exchange_rate: 3.75 },
        items: [item({ currency_id: 'USD', unit_price: 100, quantity: 1 })],
      })

    const enSoles = calculateDocument(params('PEN'))
    calculateDocument(params('USD'))
    expect(calculateDocument(params('PEN')).totals).toEqual(enSoles.totals)
  })

  it('en su moneda original no se aplica conversión', () => {
    const r = calculateDocument(
      doc({ document: { currency_id: 'USD', exchange_rate: 3.75 }, items: [item({ currency_id: 'USD', unit_price: 100, quantity: 1 })] }),
    )
    expect(r.lines[0].unit_price).toBe(100)
  })

  it('no muta la entrada', () => {
    const entrada = doc({
      document: { currency_id: 'PEN', exchange_rate: 3.75 },
      items: [item({ currency_id: 'USD', unit_price: 100, quantity: 1 })],
    })
    const copia = structuredClone(entrada)
    calculateDocument(entrada)
    expect(entrada).toEqual(copia)
  })

  it('exige el tipo de cambio si hay ítems en otra moneda', () => {
    expect(() =>
      calculateDocument(doc({ items: [item({ currency_id: 'USD' })] })),
    ).toThrow(/tipo de cambio/)
  })

  it('la salida conserva el importe original del ítem', () => {
    const r = enUsd(3.75)
    expect(r.lines[0].source).toMatchObject({ currency_id: 'USD', unit_price: 100 })
  })
})

describe('descuentos y cargos', () => {
  it('descuento de línea en porcentaje', () => {
    const r = calculateDocument(
      doc({ items: [item({ quantity: 1, unit_price: 118, discounts: [{ type: 'percent', value: 10 }] })] }),
    )
    expect(r.totals.total).toBeCloseTo(106.2, 2)
  })

  it('descuento global que afecta la base baja también el IGV', () => {
    const r = calculateDocument(
      doc({
        items: [item({ quantity: 1, unit_price: 211 })],
        global_discounts: [{ type: 'percent', value: 10, affects_base: true }],
      }),
    )
    expect(r.totals.total).toBe(189.9)
    expect(r.totals.total_igv).toBeLessThan(32.19)
  })

  it('descuento global que NO afecta la base deja base e IGV intactos', () => {
    const r = calculateDocument(
      doc({
        items: [item({ quantity: 1, unit_price: 211 })],
        global_discounts: [{ type: 'percent', value: 10, affects_base: false }],
      }),
    )
    expect(r.totals.total).toBe(189.9)
    expect(r.totals.total_igv).toBe(32.19)
  })

  it('cargo global sube el total', () => {
    const r = calculateDocument(
      doc({ items: [item({ quantity: 1, unit_price: 100 })], global_charges: [{ type: 'amount', value: 10 }] }),
    )
    expect(r.totals.total).toBeGreaterThan(100)
  })

  /* El defecto de la v1: sin `type` el descuento se descartaba en silencio. */
  it('un descuento global sin `type` ahora es error, no un descuento perdido', () => {
    expect(() => calculateDocument(doc({ global_discounts: [{ value: 10 }] }))).toThrow(ValidationError)
  })

  it('rechaza un porcentaje mayor a 100', () => {
    expect(() => calculateDocument(doc({ global_discounts: [{ type: 'percent', value: 120 }] }))).toThrow(ValidationError)
  })
})

describe('ICBPER', () => {
  it('suma el impuesto por bolsa sin tocar la base del IGV', () => {
    const r = calculateDocument(
      doc({ items: [item({ quantity: 2, unit_price: 50, has_icbper: true, icbper_rate: 0.5 })] }),
    )
    expect(r.totals.total_icbper).toBe(1)
    expect(r.totals.total).toBe(101)
    expect(r.totals.total_base_igv).toBeCloseTo(84.75, 2)
  })

  it('permite una cantidad de bolsas distinta de la del ítem', () => {
    const r = calculateDocument(
      doc({ items: [item({ quantity: 10, unit_price: 1, has_icbper: true, icbper_rate: 0.5, icbper_quantity: 2 })] }),
    )
    expect(r.totals.total_icbper).toBe(1)
  })

  it('exige el monto por bolsa si la línea lo declara', () => {
    expect(() => calculateDocument(doc({ items: [item({ has_icbper: true })] }))).toThrow(/icbper/i)
  })
})

describe('detracción', () => {
  const conDetraccion = (total, over = {}) =>
    calculateDocument(
      doc({
        items: [item({ quantity: 1, unit_price: total })],
        detraction: { type_id: '01', percentage: 12, ...over },
      }),
    )

  it('calcula el monto y lo descuenta del importe a pagar', () => {
    const r = conDetraccion(1000)
    expect(r.detraction.amount).toBe(120)
    expect(r.totals.total).toBe(1000)
    expect(r.totals.total_pay).toBe(880)
  })

  it('no aplica bajo el mínimo de S/ 700 y explica por qué', () => {
    const r = conDetraccion(500)
    expect(r.detraction.applies).toBe(false)
    expect(r.detraction.amount).toBe(0)
    expect(r.detraction.reason).toMatch(/no alcanza el mínimo/)
    expect(r.totals.total_pay).toBe(500)
  })

  it('toma el porcentaje del catálogo si no se envía', () => {
    const r = calculateDocument(
      doc({
        catalogs: { ...CAT, detraction_types: [{ id: '01', code: '001', percentage: 10, minimum_amount: 700 }] },
        items: [item({ quantity: 1, unit_price: 1000 })],
        detraction: { type_id: '01' },
      }),
    )
    expect(r.detraction.percentage).toBe(10)
    expect(r.detraction.amount).toBe(100)
  })

  it('en moneda extranjera detrae sobre el equivalente en soles', () => {
    const r = calculateDocument(
      doc({
        document: { currency_id: 'USD', exchange_rate: 3.75 },
        items: [item({ quantity: 1, unit_price: 300, currency_id: 'USD' })],
        detraction: { type_id: '01', percentage: 10 },
      }),
    )
    expect(r.detraction.base).toBe(1125) // 300 × 3.75
    expect(r.detraction.amount).toBe(112.5)
    expect(r.detraction.amount_currency_id).toBe('PEN')
  })

  it('rechaza un tipo que no está en el catálogo y sin porcentaje explícito', () => {
    expect(() =>
      calculateDocument(doc({ catalogs: { ...CAT, detraction_types: [] }, detraction: { type_id: '99' } })),
    ).toThrow(ValidationError)
  })
})

describe('retención', () => {
  it('retiene el porcentaje del total y baja el importe a pagar', () => {
    const r = calculateDocument(
      doc({ items: [item({ quantity: 1, unit_price: 1000 })], retention: { type_id: '01', percentage: 3 } }),
    )
    expect(r.retention.amount).toBe(30)
    expect(r.totals.total_pay).toBe(970)
  })

  it('convive con la detracción: ambas descuentan del importe a pagar', () => {
    const r = calculateDocument(
      doc({
        items: [item({ quantity: 1, unit_price: 1000 })],
        detraction: { type_id: '01', percentage: 10 },
        retention: { percentage: 3 },
      }),
    )
    expect(r.totals.total_pay).toBe(870)
  })
})

describe('notas de crédito y débito', () => {
  const nota = (tipoDoc, note, over = {}) =>
    calculateNote(
      doc({
        document: { document_type_id: tipoDoc },
        note: {
          affected_document_type_id: '01',
          affected_series: 'F001',
          affected_number: 1,
          description: 'Motivo',
          ...note,
        },
        ...over,
      }),
    )

  it('nota de crédito por anulación lleva los importes del comprobante', () => {
    const r = nota('07', { type_id: '01' })
    expect(r.totals.total).toBe(150)
    expect(r.note).toMatchObject({ kind: 'credit', type_id: '01', zero_amounts: false })
  })

  it('la NC 13 (ajuste de montos/fechas) va SIN importes', () => {
    const r = nota('07', { type_id: '13' })
    expect(r.totals.total).toBe(0)
    expect(r.totals.total_igv).toBe(0)
    expect(r.lines).toHaveLength(0)
    expect(r.note.zero_amounts).toBe(true)
  })

  it('la NC 03 (corrección de la descripción) también', () => {
    expect(nota('07', { type_id: '03' }).totals.total).toBe(0)
  })

  it('nota de débito por intereses', () => {
    const r = nota('08', { type_id: '01' })
    expect(r.note.kind).toBe('debit')
    expect(r.totals.total).toBe(150)
  })

  it('acepta todos los tipos del catálogo 09', () => {
    for (const tipo of ['01', '02', '04', '05', '06', '07', '08', '09', '10', '11', '12']) {
      expect(() => nota('07', { type_id: tipo }), `NC ${tipo}`).not.toThrow()
    }
  })

  it('rechaza un tipo de nota inexistente', () => {
    expect(() => nota('07', { type_id: '99' })).toThrow(/no existe/)
  })

  it('exige identificar el comprobante afectado', () => {
    expect(() =>
      calculateNote(doc({ document: { document_type_id: '07' }, note: { type_id: '01', description: 'x' } })),
    ).toThrow(/afectado/)
  })

  it('una nota sin bloque `note` es error', () => {
    expect(() => calculateDocument(doc({ document: { document_type_id: '07' } }))).toThrow(/nota de crédito/)
  })

  it('un comprobante normal con bloque `note` también', () => {
    expect(() => calculateDocument(doc({ note: { type_id: '01' } }))).toThrow(/no es una nota/)
  })

  it('calculateNote rechaza un tipo que no es nota', () => {
    expect(() => calculateNote(doc())).toThrow(/espera una nota/)
  })
})

describe('catálogo inyectado', () => {
  it('respeta la clasificación del consumidor y no una tabla interna', () => {
    // El consumidor declara el 30 como GRATUITO (no es lo habitual, pero es su tabla).
    const propio = [
      { id: '10', free: 0, exportation: 0, parent: '10' },
      { id: '30', free: 1, exportation: 0, parent: '30' },
    ]
    const r = calculateDocument({
      catalogs: { affectation_igv_types: propio },
      document: { document_type_id: '01', currency_id: 'PEN', igv_rate: 0.18 },
      items: [item({ affectation_igv_type_id: '30', quantity: 1, unit_price: 100 })],
    })
    expect(r.lines[0].is_free).toBe(true)
    expect(r.totals.total).toBe(0)
  })

  it('rechaza un código que no está en el catálogo', () => {
    expect(() => calculateDocument(doc({ items: [item({ affectation_igv_type_id: '99' })] })))
      .toThrow(/no está en el catálogo/)
  })

  it('rechaza un código inactivo', () => {
    const conInactivo = [{ id: '10', free: 0, exportation: 0, parent: '10', is_active: 0 }]
    expect(() =>
      calculateDocument({
        catalogs: { affectation_igv_types: conInactivo },
        document: { document_type_id: '01', currency_id: 'PEN', igv_rate: 0.18 },
        items: [item()],
      }),
    ).toThrow(/inactivo/)
  })

  it('rechaza IVAP (17) en vez de calcularlo mal', () => {
    expect(() => calculateDocument(doc({ items: [item({ affectation_igv_type_id: '17' })] })))
      .toThrow(/IVAP/)
  })

  it('sin catálogo usa el de referencia', () => {
    const r = calculateDocument({
      document: { document_type_id: '01', currency_id: 'PEN', igv_rate: 0.18 },
      items: [item()],
    })
    expect(r.totals.total).toBe(150)
  })
})

describe('validación', () => {
  it('acumula TODOS los problemas, no solo el primero', () => {
    try {
      calculateDocument({ document: {}, items: [{ quantity: 0 }] })
      expect.unreachable('debía lanzar')
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError)
      expect(e.errors.length).toBeGreaterThan(3)
      expect(e.byPath()).toHaveProperty('document.document_type_id')
    }
  })

  it('cada problema trae ruta y código estables', () => {
    try {
      calculateDocument(doc({ items: [item({ quantity: -1 })] }))
    } catch (e) {
      const q = e.errors.find((x) => x.path === 'items[0].quantity')
      expect(q).toMatchObject({ code: 'invalid' })
    }
  })

  it('un documento sin ítems es error', () => {
    expect(() => calculateDocument(doc({ items: [] }))).toThrow(/al menos un ítem/)
  })

  it('la tasa de IGV se expresa como fracción', () => {
    expect(() => calculateDocument(doc({ document: { igv_rate: 18 } }))).toThrow(/fracción/)
  })
})

describe('metadata de salida', () => {
  it('refleja los parámetros con los que se calculó', () => {
    const r = calculateDocument(doc({ document: { operation_type_id: '0101', exchange_rate: 3.75 } }))
    expect(r.meta).toMatchObject({
      document_type_id: '01', operation_type_id: '0101', currency_id: 'PEN',
      igv_rate: 0.18, pricing_mode: 'price', engine_version: 2,
    })
  })
})
