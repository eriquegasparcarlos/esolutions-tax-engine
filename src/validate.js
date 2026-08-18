/**
 * Validación de entrada.
 *
 * Es ESTRICTA a propósito: se acumulan todos los problemas y se lanza `ValidationError`.
 * Nada se asume por defecto si el valor cambia un importe — un default silencioso acá es
 * un comprobante mal emitido allá.
 *
 * Qué se valida: lo que SUNAT exige para aceptar el comprobante (probado contra
 * esolutions/xml, que corre el XSD y las reglas) y lo que el motor necesita para no
 * calcular sobre datos ambiguos.
 */

import { ValidationError } from './errors.js'
import { CREDIT_NOTE_TYPES, DEBIT_NOTE_TYPES } from './catalogs.js'

const esNumero = (v) => v !== null && v !== '' && v !== undefined && Number.isFinite(Number(v))
const esTexto = (v) => typeof v === 'string' && v.trim() !== ''

/** Tipos de comprobante que llevan nota asociada (catálogo 01 de SUNAT). */
export const NOTE_DOCUMENT_TYPES = { CREDIT: '07', DEBIT: '08' }

/**
 * @param {Object} input      entrada completa
 * @param {Object} resolvers  catálogos ya normalizados (buildCatalogs)
 * @throws {ValidationError}
 */
export function validateInput(input, resolvers) {
  /** @type {import('./errors.js').Issue[]} */
  const errors = []
  const add = (path, code, message) => errors.push({ path, code, message })

  if (!input || typeof input !== 'object') {
    throw new ValidationError([
      { path: '', code: 'input_required', message: 'Se esperaba un objeto de entrada.' },
    ])
  }

  const doc = input.document ?? {}
  const items = Array.isArray(input.items) ? input.items : null

  // ── Documento ─────────────────────────────────────────────────────────────
  if (!esTexto(doc.document_type_id)) {
    add('document.document_type_id', 'required', 'El tipo de comprobante es obligatorio (01, 03, 07, 08…).')
  }

  if (!esTexto(doc.currency_id)) {
    add('document.currency_id', 'required', 'La moneda del comprobante es obligatoria (PEN, USD…).')
  }

  if (!esNumero(doc.igv_rate)) {
    add('document.igv_rate', 'required', 'La tasa de IGV es obligatoria; se espera la fracción (0.18), no el porcentaje.')
  } else if (Number(doc.igv_rate) < 0 || Number(doc.igv_rate) > 1) {
    add('document.igv_rate', 'out_of_range', 'La tasa de IGV se expresa como fracción entre 0 y 1 (0.18 = 18%).')
  }

  if (doc.pricing_mode !== undefined && !['price', 'value'].includes(doc.pricing_mode)) {
    add('document.pricing_mode', 'invalid', "El modo de precio debe ser 'price' (con IGV) o 'value' (sin IGV).")
  }

  // El tipo de cambio solo hace falta si de verdad hay que convertir. Se valida abajo,
  // cuando se sabe si algún ítem viene en otra moneda.
  if (doc.exchange_rate !== undefined && doc.exchange_rate !== null) {
    if (!esNumero(doc.exchange_rate) || Number(doc.exchange_rate) <= 0) {
      add('document.exchange_rate', 'invalid', 'El tipo de cambio debe ser un número mayor que cero.')
    }
  }

  // ── Ítems ─────────────────────────────────────────────────────────────────
  const esNotaSinImportes = isZeroAmountNote(input)

  if (items === null) {
    add('items', 'required', 'Se espera un arreglo de ítems.')
  } else if (items.length === 0 && !esNotaSinImportes) {
    add('items', 'empty', 'El comprobante necesita al menos un ítem.')
  } else {
    const modoDoc = doc.pricing_mode ?? 'price'
    let algunaOtraMoneda = false

    items.forEach((item, i) => {
      const p = `items[${i}]`

      if (!esNumero(item?.quantity) || Number(item.quantity) <= 0) {
        add(`${p}.quantity`, 'invalid', 'La cantidad debe ser un número mayor que cero.')
      }

      // Afectación: tiene que existir EN EL CATÁLOGO INYECTADO, estar activa y ser
      // calculable. No se adivina por el número.
      const cod = item?.affectation_igv_type_id
      if (cod == null || String(cod) === '') {
        add(`${p}.affectation_igv_type_id`, 'required', 'El tipo de afectación IGV es obligatorio.')
      } else {
        const af = resolvers.affectation.get(cod)
        if (!af) {
          add(`${p}.affectation_igv_type_id`, 'unknown_code',
            `El código de afectación "${cod}" no está en el catálogo recibido.`)
        } else if (!af.isActive) {
          add(`${p}.affectation_igv_type_id`, 'inactive_code',
            `El código de afectación "${cod}" está inactivo en el catálogo.`)
        } else if (!af.supported) {
          add(`${p}.affectation_igv_type_id`, 'unsupported_code',
            `El código "${cod}" (${af.name}) requiere IVAP, que este motor todavía no calcula. ` +
            'Emitirlo daría importes incorrectos.')
        }
      }

      // Precio o valor, según el modo. Uno de los dos tiene que venir.
      const modo = item?.pricing_mode ?? modoDoc
      if (item?.pricing_mode !== undefined && !['price', 'value'].includes(item.pricing_mode)) {
        add(`${p}.pricing_mode`, 'invalid', "El modo de precio debe ser 'price' o 'value'.")
      }

      const tienePrecio = esNumero(item?.unit_price)
      const tieneValor = esNumero(item?.unit_value)

      if (!tienePrecio && !tieneValor) {
        add(`${p}.unit_price`, 'required',
          'Falta el importe unitario: `unit_price` (con IGV) o `unit_value` (sin IGV).')
      } else if (modo === 'price' && !tienePrecio) {
        add(`${p}.unit_price`, 'required',
          "Con pricing_mode 'price' se espera `unit_price`; llegó solo `unit_value`.")
      } else if (modo === 'value' && !tieneValor) {
        add(`${p}.unit_value`, 'required',
          "Con pricing_mode 'value' se espera `unit_value`; llegó solo `unit_price`.")
      }

      if (tienePrecio && Number(item.unit_price) < 0) {
        add(`${p}.unit_price`, 'negative', 'El precio unitario no puede ser negativo.')
      }
      if (tieneValor && Number(item.unit_value) < 0) {
        add(`${p}.unit_value`, 'negative', 'El valor unitario no puede ser negativo.')
      }

      if (item?.currency_id && doc.currency_id && item.currency_id !== doc.currency_id) {
        algunaOtraMoneda = true
      }

      validarOps(item?.discounts, `${p}.discounts`, 'descuento', add)
      validarOps(item?.charges, `${p}.charges`, 'cargo', add)

      // ICBPER: si se declara, hace falta el monto por unidad.
      if (item?.has_icbper) {
        const tasa = item.icbper_rate ?? doc.icbper_rate
        if (!esNumero(tasa) || Number(tasa) <= 0) {
          add(`${p}.icbper_rate`, 'required',
            'La línea declara ICBPER: se necesita `icbper_rate` (monto por bolsa) en el ítem o en el documento.')
        }
      }
    })

    if (algunaOtraMoneda && (!esNumero(doc.exchange_rate) || Number(doc.exchange_rate) <= 0)) {
      add('document.exchange_rate', 'required',
        'Hay ítems en una moneda distinta a la del comprobante: se necesita el tipo de cambio.')
    }
  }

  // ── Globales ──────────────────────────────────────────────────────────────
  // El caso que motivó esta validación: hasta la v1, un descuento global sin `type` se
  // descartaba EN SILENCIO. El usuario lo veía en pantalla y el comprobante salía por el
  // total completo.
  validarOps(input.global_discounts, 'global_discounts', 'descuento global', add)
  validarOps(input.global_charges, 'global_charges', 'cargo global', add)

  // ── Detracción ────────────────────────────────────────────────────────────
  if (input.detraction) {
    const d = input.detraction
    const tipo = d.type_id != null ? resolvers.detraction.get(d.type_id) : null

    if (d.type_id == null) {
      add('detraction.type_id', 'required', 'La detracción necesita el tipo (código del catálogo 54).')
    } else if (!tipo && !esNumero(d.percentage)) {
      add('detraction.type_id', 'unknown_code',
        `El tipo de detracción "${d.type_id}" no está en el catálogo recibido y no se envió `
        + '`percentage` como alternativa.')
    }

    const pct = esNumero(d.percentage) ? Number(d.percentage) : tipo?.percentage
    if (!esNumero(pct) || pct <= 0 || pct > 100) {
      add('detraction.percentage', 'invalid',
        'El porcentaje de detracción debe estar entre 0 y 100 (se toma del catálogo si no se envía).')
    }

    if (d.payment_method_id !== undefined && !esTexto(d.payment_method_id)) {
      add('detraction.payment_method_id', 'invalid', 'El medio de pago de la detracción debe ser un texto.')
    }
  }

  // ── Retención ─────────────────────────────────────────────────────────────
  if (input.retention) {
    const r = input.retention
    const tipo = r.type_id != null ? resolvers.retention.get(r.type_id) : null
    const pct = esNumero(r.percentage) ? Number(r.percentage) : tipo?.percentage

    if (r.type_id == null && !esNumero(r.percentage)) {
      add('retention.type_id', 'required',
        'La retención necesita el tipo del catálogo o un `percentage` explícito.')
    }
    if (!esNumero(pct) || pct <= 0 || pct > 100) {
      add('retention.percentage', 'invalid', 'El porcentaje de retención debe estar entre 0 y 100.')
    }
  }

  // ── Notas de crédito / débito ─────────────────────────────────────────────
  const tipoDoc = String(doc.document_type_id ?? '')
  if (tipoDoc === NOTE_DOCUMENT_TYPES.CREDIT || tipoDoc === NOTE_DOCUMENT_TYPES.DEBIT) {
    const esCredito = tipoDoc === NOTE_DOCUMENT_TYPES.CREDIT
    const tabla = esCredito ? CREDIT_NOTE_TYPES : DEBIT_NOTE_TYPES
    const etiqueta = esCredito ? 'crédito' : 'débito'
    const nota = input.note

    if (!nota) {
      add('note', 'required',
        `Un comprobante ${tipoDoc} es una nota de ${etiqueta}: falta el bloque \`note\`.`)
    } else {
      if (!esTexto(nota.type_id)) {
        add('note.type_id', 'required', `Falta el tipo de nota de ${etiqueta}.`)
      } else if (!tabla[nota.type_id]) {
        add('note.type_id', 'unknown_code',
          `El tipo de nota de ${etiqueta} "${nota.type_id}" no existe. Válidos: ${Object.keys(tabla).join(', ')}.`)
      }

      // SUNAT exige identificar el comprobante que se modifica.
      if (!esTexto(nota.affected_document_type_id)) {
        add('note.affected_document_type_id', 'required',
          'Falta el tipo del comprobante afectado por la nota.')
      }
      if (!esTexto(nota.affected_series)) {
        add('note.affected_series', 'required', 'Falta la serie del comprobante afectado.')
      }
      if (!esNumero(nota.affected_number)) {
        add('note.affected_number', 'required', 'Falta el número del comprobante afectado.')
      }
      if (!esTexto(nota.description)) {
        add('note.description', 'required', 'La nota necesita el motivo o sustento en texto.')
      }
    }
  } else if (input.note) {
    add('note', 'unexpected',
      `Se envió el bloque \`note\` pero el tipo de comprobante es ${tipoDoc}, que no es una nota.`)
  }

  if (errors.length > 0) {
    throw new ValidationError(errors)
  }
}

/** Descuentos y cargos, de línea o globales: misma forma, mismas reglas. */
function validarOps(ops, path, etiqueta, add) {
  if (ops === undefined || ops === null) return

  if (!Array.isArray(ops)) {
    add(path, 'invalid', `Se espera un arreglo de ${etiqueta}s.`)
    return
  }

  ops.forEach((op, i) => {
    const p = `${path}[${i}]`

    if (!op || typeof op !== 'object') {
      add(p, 'invalid', `Cada ${etiqueta} debe ser un objeto.`)
      return
    }

    if (!['percent', 'amount'].includes(op.type)) {
      add(`${p}.type`, 'required',
        `Cada ${etiqueta} debe declarar \`type\`: 'percent' (porcentaje) o 'amount' (monto fijo).`)
    }

    if (!esNumero(op.value) || Number(op.value) <= 0) {
      add(`${p}.value`, 'invalid', `El valor del ${etiqueta} debe ser un número mayor que cero.`)
    } else if (op.type === 'percent' && Number(op.value) > 100) {
      add(`${p}.value`, 'out_of_range', `Un ${etiqueta} en porcentaje no puede superar 100.`)
    }

    if (op.affects_base !== undefined && typeof op.affects_base !== 'boolean') {
      add(`${p}.affects_base`, 'invalid',
        '`affects_base` debe ser booleano: indica si el ajuste modifica la base imponible del IGV.')
    }
  })
}

/** Notas cuyo motivo NO lleva importes (corrección de texto, ajuste de fechas de pago). */
export function isZeroAmountNote(input) {
  const tipoDoc = String(input?.document?.document_type_id ?? '')
  if (tipoDoc !== NOTE_DOCUMENT_TYPES.CREDIT) return false
  return CREDIT_NOTE_TYPES[input?.note?.type_id]?.zeroAmounts === true
}
