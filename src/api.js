/**
 * API pública del motor. Dos funciones: `calculateDocument` y `calculateNote`.
 *
 * CONTRATO
 * Se envía todo lo que define el comprobante y se recibe todo calculado. El motor no
 * consulta nada afuera, no guarda estado y no muta la entrada: mismos parámetros → mismo
 * resultado, siempre.
 *
 * ESA PUREZA ES LO QUE HACE REVERSIBLES LOS CAMBIOS DE MONEDA Y TIPO DE CAMBIO.
 * Los importes se derivan SIEMPRE de los valores originales del ítem (su moneda y su
 * precio tal como los cargó el usuario), nunca de un resultado anterior. Entonces cambiar
 * la moneda del comprobante, o corregir el tipo de cambio, es volver a llamar la función:
 * los valores iniciales se recuperan exactos porque nunca se perdieron. Si el motor
 * reescribiera los ítems en cada pasada, volver atrás acumularía error de redondeo.
 *
 * QUÉ CUBRE
 *   · Precio unitario (con IGV) o valor unitario (sin IGV), por documento o por ítem
 *   · Descuentos y cargos por línea y globales, afecten o no la base imponible
 *   · Las cinco categorías del catálogo 07 según la tabla que inyecta el consumidor
 *   · ICBPER (bolsas plásticas)
 *   · Detracción y retención
 *   · Moneda del ítem distinta a la del comprobante, con tipo de cambio
 *   · Notas de crédito (catálogo 09) y de débito (catálogo 10), todos los tipos
 *
 * QUÉ NO CUBRE (se rechaza con error, no se calcula mal)
 *   · IVAP (afectación 17) · ISC
 */

import { buildCatalogs, CATEGORY, CREDIT_NOTE_TYPES, DEBIT_NOTE_TYPES } from './catalogs.js'
import { ValidationError } from './errors.js'
import { validateInput, isZeroAmountNote, NOTE_DOCUMENT_TYPES } from './validate.js'
import { normalizeItemPricing, projectItemToDocCurrency, calculateTotalsWithGlobals } from './billing.js'

const money = (v) => Number((Number(v ?? 0)).toFixed(2))

/**
 * Calcula un comprobante completo.
 *
 * @param {Object}   input
 * @param {Object}   input.document
 * @param {string}   input.document.document_type_id  catálogo 01: '01' factura, '03' boleta…
 * @param {string}   input.document.currency_id       moneda del comprobante: 'PEN', 'USD'
 * @param {number}   input.document.igv_rate          fracción: 0.18 (no 18)
 * @param {number}  [input.document.exchange_rate]    obligatorio si algún ítem va en otra moneda
 * @param {'price'|'value'} [input.document.pricing_mode='price']  cómo se interpretan los importes
 * @param {number}  [input.document.icbper_rate]      monto por bolsa, si no viene por ítem
 * @param {string}  [input.document.operation_type_id] catálogo 17; se refleja en la salida
 * @param {Array}    input.items                      ver `calculateDocument.itemShape` abajo
 * @param {Array}   [input.global_discounts]          [{type:'percent'|'amount', value, affects_base?, reason_code?}]
 * @param {Array}   [input.global_charges]            idem
 * @param {Object}  [input.detraction]                {type_id, percentage?, payment_method_id?, account?}
 * @param {Object}  [input.retention]                 {type_id?, percentage?}
 * @param {Object}  [input.note]                      solo para 07/08; ver calculateNote
 * @param {Object}  [input.catalogs]                  {affectation_igv_types, detraction_types, retention_types}
 * @returns {DocumentResult}
 * @throws {ValidationError|UnsupportedError}
 */
export function calculateDocument(input) {
  const resolvers = buildCatalogs(input?.catalogs ?? {})
  validateInput(input, resolvers)

  const doc = input.document
  const igvRate = Number(doc.igv_rate)
  const docCurrency = doc.currency_id
  const exchangeRate = doc.exchange_rate != null ? Number(doc.exchange_rate) : 1
  const modoDoc = doc.pricing_mode ?? 'price'

  // Nota sin importes (corrección de texto, ajuste de fechas): SUNAT la quiere en cero.
  const sinImportes = isZeroAmountNote(input)

  /*
  | 1) Normalización. Se parte SIEMPRE de los valores originales del ítem. `_source`
  |    conserva lo que mandó el consumidor para que la salida pueda mostrarlo y para
  |    dejar explícito que el motor no lo pisó.
  */
  const preparados = (input.items ?? []).map((item) => {
    const modo = item.pricing_mode ?? modoDoc
    const monedaItem = item.currency_id ?? docCurrency

    const base = normalizeItemPricing(
      {
        ...item,
        pricing_mode: modo,
        currency_id: monedaItem,
        affectation_igv_type_id: String(item.affectation_igv_type_id),
        discounts: mapOps(item.discounts),
        charges: mapOps(item.charges),
      },
      igvRate,
      resolvers.affectation,
    )

    // Proyección de moneda: solo si la del ítem difiere de la del comprobante.
    const proyectado =
      monedaItem === docCurrency
        ? base
        : projectItemToDocCurrency(base, docCurrency, exchangeRate, igvRate, resolvers.affectation)

    proyectado._source = {
      currency_id: monedaItem,
      pricing_mode: modo,
      unit_price: item.unit_price ?? null,
      unit_value: item.unit_value ?? null,
    }

    return proyectado
  })

  /*
  | 2) Cálculo por línea y del documento, con los globales. Es el motor ya validado
  |    contra SUNAT; acá solo se le pasa la clasificación del catálogo del consumidor.
  */
  const globales = mapGlobales(input)
  const calc = calculateTotalsWithGlobals(preparados, {
    igvRate,
    affectation: resolvers.affectation,
    globalDiscounts: globales.discounts,
    globalCharges: globales.charges,
    globalAffectsBase: globales.affectsBase,
  })

  /*
  | 3) ICBPER. Es un impuesto por unidad, ajeno a la base del IGV: se suma al total a
  |    pagar y se informa aparte. El motor heredado no lo calculaba.
  */
  const icbper = calcularIcbper(input.items ?? [], doc)

  /*
  | 4) Salida por línea.
  */
  const lines = calc.items.map((linea, i) => {
    const af = resolvers.affectation.get(linea.affectation_igv_type_id)
    const icb = icbper.porLinea[i] ?? 0
    // El cálculo por línea devuelve un objeto nuevo, así que el origen se toma del ítem
    // preparado y no de la línea calculada.
    const source = preparados[i]?._source ?? null

    return {
      index: i,
      item_id: linea.item_id,
      name: linea.name,
      unit_type_id: linea.unit_type_id,
      quantity: linea.quantity,

      unit_value: linea.unit_value,
      unit_price: linea.unit_price,

      affectation_igv_type_id: linea.affectation_igv_type_id,
      affectation_category: linea.category,
      affectation_name: af?.name ?? '',
      is_free: linea.category === CATEGORY.FREE,
      // Catálogo 16: '01' precio unitario de una operación onerosa, '02' valor
      // referencial de una gratuita. SUNAT lo exige por línea.
      price_type_id: linea.category === CATEGORY.FREE ? '02' : '01',

      total_base_igv: linea.category === CATEGORY.TAXED ? linea.base : 0,
      percentage_igv: linea.category === CATEGORY.TAXED ? money(igvRate * 100) : 0,
      total_igv: linea.tax,
      total_igv_free: linea.igv_free ?? 0,

      total_icbper: icb,
      // Monto por bolsa aplicado. Se devuelve porque el comprobante lo declara aparte
      // del total: SUNAT quiere la tasa y el importe.
      factor_icbper: icb > 0 ? Number(input.items[i].icbper_rate ?? doc.icbper_rate ?? 0) : 0,
      total_value: linea.subtotal,
      total_discount: money((linea.discounts_affect_base ?? 0) + (linea.discounts_no_base ?? 0)),
      total_charge: 0,
      total_taxes: money(linea.tax + icb),
      total: money(linea.total + icb),

      discounts: linea.itemAllowances ?? [],
      charges: linea.itemCharges ?? [],

      // Lo que mandó el consumidor, sin tocar: sirve para repintar el formulario y para
      // poder recalcular con otra moneda sin haber perdido el dato de origen.
      source,
    }
  })

  const t = calc.totals

  /*
  | 5) Detracción y retención. Se calculan sobre el total del comprobante YA con IGV, y
  |    no lo modifican: cambian lo que el cliente efectivamente transfiere.
  */
  const totalConIcbper = money(t.total + icbper.total)
  const detraction = calcularDetraccion(input.detraction, totalConIcbper, resolvers, docCurrency, exchangeRate)
  const retention = calcularRetencion(input.retention, totalConIcbper, resolvers)

  const totalPagar = money(totalConIcbper - (detraction?.amount ?? 0) - (retention?.amount ?? 0))

  const totals = {
    total_taxed: sinImportes ? 0 : t.total_taxed,
    total_exonerated: sinImportes ? 0 : t.total_exonerated,
    total_unaffected: sinImportes ? 0 : t.total_unaffected,
    total_exportation: sinImportes ? 0 : t.total_exportation,
    total_free: sinImportes ? 0 : t.total_free_ref,

    total_value: sinImportes ? 0 : t.subtotal,
    total_base_igv: sinImportes ? 0 : t.taxable_base,
    total_igv: sinImportes ? 0 : t.tax,
    total_igv_free: sinImportes ? 0 : t.total_igv_free,
    total_icbper: sinImportes ? 0 : icbper.total,
    total_taxes: sinImportes ? 0 : money(t.tax + icbper.total),

    total_discount: sinImportes ? 0 : money(t.total_discount),
    total_charge: sinImportes ? 0 : money(t.total_charge),

    total: sinImportes ? 0 : totalConIcbper,
    total_pay: sinImportes ? 0 : totalPagar,
  }

  return {
    totals,
    lines: sinImportes ? [] : lines,
    detraction,
    retention,
    global_discounts: mapGlobalesSalida(calc.documentAllowances, globales.affectsBase, false),
    global_charges: mapGlobalesSalida(calc.documentCharges, globales.affectsBase, true),
    note: input.note ? describirNota(input) : null,
    meta: {
      document_type_id: doc.document_type_id,
      operation_type_id: doc.operation_type_id ?? null,
      currency_id: docCurrency,
      exchange_rate: exchangeRate,
      igv_rate: igvRate,
      pricing_mode: modoDoc,
      zero_amounts: sinImportes,
      engine_version: 2,
    },
  }
}

/**
 * Nota de crédito (07) o de débito (08).
 *
 * Es `calculateDocument` con las reglas propias de la nota. Se expone aparte porque la
 * entrada obligatoria es distinta —hay que identificar el comprobante afectado y el
 * motivo— y porque hay motivos que NO llevan importes: la 03 (corrección de la
 * descripción) y la 13 (ajuste de montos o fechas de pago) van en cero, y mandarlas con
 * importes es motivo de rechazo.
 *
 * @param {Object} input  igual que calculateDocument, con `note` obligatorio:
 *   {type_id, description, affected_document_type_id, affected_series, affected_number}
 */
export function calculateNote(input) {
  const tipo = String(input?.document?.document_type_id ?? '')

  if (tipo !== NOTE_DOCUMENT_TYPES.CREDIT && tipo !== NOTE_DOCUMENT_TYPES.DEBIT) {
    throw new ValidationError([
      {
        path: 'document.document_type_id',
        code: 'not_a_note',
        message: `calculateNote espera una nota: '07' (crédito) u '08' (débito); llegó '${tipo}'.`,
      },
    ])
  }

  return calculateDocument(input)
}

// ─── Auxiliares ──────────────────────────────────────────────────────────────

/** Traduce los descuentos/cargos del contrato público a la forma interna del motor. */
function mapOps(ops) {
  if (!Array.isArray(ops)) return []
  return ops.map((op) => ({
    type: op.type,
    value: Number(op.value),
    affectsBase: op.affects_base !== false, // por defecto afectan la base
    reasonCode: op.reason_code ?? null,
    charge: op.charge === true,
  }))
}

function mapGlobales(input) {
  const discounts = mapOps(input.global_discounts)
  const charges = mapOps(input.global_charges).map((c) => ({ ...c, charge: true }))

  // Si TODOS los globales declaran que no afectan la base, el documento se calcula con
  // el modelo del catálogo 53 código 02: base e IGV intactos, solo baja el importe a
  // pagar. Basta con que uno afecte para repartir dentro de las líneas (lo que exige
  // SUNAT en la nota de crédito por descuento global; si no, rechaza con 3277).
  const todos = [...discounts, ...charges]
  const affectsBase = todos.length === 0 ? true : todos.some((o) => o.affectsBase)

  return { discounts, charges, affectsBase }
}

/**
 * Descuentos y cargos globales, en la forma en que hay que declararlos.
 *
 * `reason_code` es el código de motivo que SUNAT exige y sin el cual el comprobante no se
 * puede armar. Si el consumidor no lo envía se deduce del catálogo 53: `02` cuando el
 * descuento afecta la base imponible y `03` cuando no. Para los cargos se usa `51`
 * (catálogo 55). Devolverlo vacío obligaría a que cada aplicación reinvente esta tabla.
 */
function mapGlobalesSalida(filas, affectsBase, esCargo) {
  const porDefecto = esCargo ? '51' : affectsBase ? '02' : '03'

  return (filas ?? []).map((a) => {
    const percentage = Number(a.multiplierFactorNumeric ?? 0)
    return {
      reason_code: a.reasonCode ?? porDefecto,
      affects_base: affectsBase,
      base: money(a.baseAmount ?? 0),
      percentage,
      factor: Number((percentage / 100).toFixed(5)),
      amount: money(a.amount),
    }
  })
}

/**
 * ICBPER: impuesto FIJO por bolsa, no proporcional al precio y ajeno a la base del IGV.
 * `icbper_quantity` permite cobrar una cantidad de bolsas distinta de la cantidad de la
 * línea; si no viene, se usa la cantidad del ítem.
 */
function calcularIcbper(items, doc) {
  const porLinea = []
  let total = 0

  items.forEach((item, i) => {
    if (!item?.has_icbper) {
      porLinea[i] = 0
      return
    }
    const tasa = Number(item.icbper_rate ?? doc.icbper_rate ?? 0)
    const cantidad = Number(item.icbper_quantity ?? item.quantity ?? 0)
    const monto = money(tasa * cantidad)
    porLinea[i] = monto
    total = money(total + monto)
  })

  return { porLinea, total }
}

/**
 * Detracción: un porcentaje del total que el cliente deposita en la cuenta de detracciones
 * en vez de pagárselo al proveedor. No cambia los importes del comprobante — cambia
 * cuánto recibe el emisor.
 *
 * El mínimo (S/ 700 por defecto, del catálogo si viene) se evalúa sobre el total EN SOLES:
 * un comprobante en dólares se convierte con el tipo de cambio para decidir si aplica.
 */
function calcularDetraccion(entrada, total, resolvers, currencyId, exchangeRate) {
  if (!entrada) return null

  const tipo = entrada.type_id != null ? resolvers.detraction.get(entrada.type_id) : null
  const percentage = entrada.percentage != null ? Number(entrada.percentage) : tipo?.percentage
  const minimo = entrada.minimum_amount != null ? Number(entrada.minimum_amount) : (tipo?.minimumAmount ?? 700)

  const totalEnSoles = currencyId === 'PEN' ? total : money(total * exchangeRate)
  const aplica = totalEnSoles >= minimo

  return {
    type_id: entrada.type_id != null ? String(entrada.type_id) : null,
    code: tipo?.code ?? null,
    percentage: money(percentage),
    // El monto de la detracción se expresa en SOLES aunque el comprobante vaya en otra
    // moneda: el depósito al Banco de la Nación siempre es en soles.
    amount: aplica ? money(totalEnSoles * (percentage / 100)) : 0,
    amount_currency_id: 'PEN',
    base: totalEnSoles,
    minimum_amount: minimo,
    applies: aplica,
    payment_method_id: entrada.payment_method_id ?? null,
    account: entrada.account ?? null,
    // Cuando no llega al mínimo se informa por qué, en vez de devolver 0 sin explicación.
    reason: aplica ? null
      : `El total (S/ ${totalEnSoles.toFixed(2)}) no alcanza el mínimo de S/ ${minimo.toFixed(2)} para detraer.`,
  }
}

/** Retención: porcentaje que retiene el CLIENTE (agente de retención) del importe a pagar. */
function calcularRetencion(entrada, total, resolvers) {
  if (!entrada) return null

  const tipo = entrada.type_id != null ? resolvers.retention.get(entrada.type_id) : null
  const percentage = entrada.percentage != null ? Number(entrada.percentage) : tipo?.percentage

  return {
    type_id: entrada.type_id != null ? String(entrada.type_id) : null,
    code: tipo?.code ?? null,
    percentage: money(percentage),
    base: total,
    amount: money(total * (percentage / 100)),
  }
}

function describirNota(input) {
  const tipoDoc = String(input.document.document_type_id)
  const esCredito = tipoDoc === NOTE_DOCUMENT_TYPES.CREDIT
  const tabla = esCredito ? CREDIT_NOTE_TYPES : DEBIT_NOTE_TYPES
  const def = tabla[input.note.type_id]

  return {
    kind: esCredito ? 'credit' : 'debit',
    type_id: input.note.type_id,
    type_name: def?.name ?? '',
    zero_amounts: def?.zeroAmounts === true,
    description: input.note.description,
    affected_document_type_id: input.note.affected_document_type_id,
    affected_series: input.note.affected_series,
    affected_number: Number(input.note.affected_number),
  }
}
