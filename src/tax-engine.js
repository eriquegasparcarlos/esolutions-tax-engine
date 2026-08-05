/**
 * Motor de impuestos (SUNAT) — fuente única de cálculo IGV/ISC/ICBPER, redondeo
 * fiscal, afectaciones y descuento global. Funciones PURAS: sin estado reactivo y
 * sin dependencias de framework (usable en Vue, Node, cualquier JS).
 */

// ─── Redondeo ────────────────────────────────────────────────────────────────
export function round (value, decimals = 2) {
  const factor = Math.pow(10, decimals)
  return Math.round(value * factor) / factor
}

export function r2 (n) { return Math.round(n * 100) / 100 }
export function r4 (n) { return Math.round(n * 10000) / 10000 }

// ─── Tipos de afectación IGV ─────────────────────────────────────────────────
/** true para tipos 10–17 (gravado: aplica IGV). */
export function isGravado (igvType) {
  return ['10', '11', '12', '13', '14', '15', '16', '17'].includes(String(igvType))
}

/**
 * Operación GRATUITA (SUNAT cat. 07): el cliente NO paga la línea. Su valor va a
 * `total_free` y, si es gravado gratuito (11–16), su IGV a `total_igv_free` (se
 * reporta pero no se cobra). 21 = exonerado gratuito, 31/37 = inafecto gratuito.
 */
export function isGratuito (igvType) {
  return ['11', '12', '13', '14', '15', '16', '21', '31', '37'].includes(String(igvType))
}

/** Gravado gratuito (11–16): gratuito CON IGV referencial. */
export function isGravadoGratuito (igvType) {
  return ['11', '12', '13', '14', '15', '16'].includes(String(igvType))
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
export function sumBy (arr, fn) {
  return arr.reduce((sum, item) => sum + fn(item), 0)
}

export function getAmountFromInputDiscount (discount) {
  if (discount.use_input_amount !== undefined && discount.use_input_amount === true) {
    return discount.amount
  }
  return discount.percentage
}

// ─── Descuento global ────────────────────────────────────────────────────────
/**
 * Aplica un descuento global a los totales ya calculados de un documento.
 *
 * @param {Object} form         totales (total_taxed_init, total_igv, etc.)
 * @param {boolean} enabled     si el descuento está activo
 * @param {string} discountType '02' = porcentaje, cualquier otro = monto
 * @param {number} discountAmount
 * @returns {Object} nuevos totales con el descuento aplicado
 */
export function calculateDiscountGlobal (form, enabled, discountType, discountAmount) {
  const result = { ...form }
  result.discounts = []
  result.total_discount = 0

  const totalExportationInit = parseFloat(result.total_exportation_init) || 0
  const totalExoneratedInit = parseFloat(result.total_exonerated_init) || 0
  const totalUnaffectedInit = parseFloat(result.total_unaffected_init) || 0
  const totalTaxedInit = parseFloat(result.total_taxed_init) || 0
  const totalPlasticBagTaxes = parseFloat(result.total_plastic_bag_taxes) || 0
  const totalInit = parseFloat(result.total_init) - totalPlasticBagTaxes

  let totalExportation = totalExportationInit
  let totalExonerated = totalExoneratedInit
  let totalUnaffected = totalUnaffectedInit
  let totalTaxed = totalTaxedInit
  let totalIgv = parseFloat(result.total_igv) || 0
  let total = totalInit

  const amount = parseFloat(discountAmount) || 0
  let discountGlobalAmountBase = 0

  if (!enabled || amount <= 0) {
    return result
  }

  const isAmount = discountType !== '02'
  let percentage, factor

  if (isAmount) {
    percentage = amount / totalInit * 100
    factor = round(percentage / 100, 5)
    discountGlobalAmountBase = amount
  } else {
    percentage = amount
    factor = round(percentage / 100, 5)
    discountGlobalAmountBase = totalInit * factor
  }

  total = round(totalInit - discountGlobalAmountBase, 2)
  let totalPartial = total

  const categories = [
    { init: totalExportationInit, type: '03', label: 'exportation' },
    { init: totalExoneratedInit, type: '03', label: 'exonerated' },
    { init: totalUnaffectedInit, type: '03', label: 'unaffected' },
    { init: totalTaxedInit, type: '02', label: 'taxed' },
  ]

  let totalDiscountNoBase = 0
  let totalDiscountBase = 0

  for (const cat of categories) {
    if (cat.init > 0) {
      const discAmount = round(cat.init * factor, 2)
      const newValue = round(cat.init - discAmount, 2)

      if (cat.label === 'exportation') { totalExportation = newValue; totalPartial -= newValue }
      if (cat.label === 'exonerated') { totalExonerated = newValue; totalPartial -= newValue }
      if (cat.label === 'unaffected') { totalUnaffected = newValue; totalPartial -= newValue }
      if (cat.label === 'taxed') {
        totalTaxed = newValue
        totalIgv = round(totalPartial - totalTaxed, 2)
        totalDiscountBase = discAmount
      } else {
        totalDiscountNoBase += discAmount
      }

      result.discounts.push({
        discount_type_id: cat.type,
        description: cat.type === '02'
          ? 'Descuentos globales que afectan la base imponible del IGV/IVAP'
          : 'Descuentos globales que no afectan la base imponible del IGV/IVAP',
        factor, amount: discAmount, base: cat.init, percentage,
        is_amount: isAmount, type: discountType, amount_base: amount,
      })
    }
  }

  result.total_discount_no_base = totalDiscountNoBase
  result.total_discount_base = totalDiscountBase
  result.total_discount = discountGlobalAmountBase
  result.total_exportation = parseFloat(totalExportation.toFixed(2))
  result.total_unaffected = parseFloat(totalUnaffected.toFixed(2))
  result.total_exonerated = parseFloat(totalExonerated.toFixed(2))
  result.total_taxed = parseFloat(totalTaxed.toFixed(2))
  result.subtotal = round(totalUnaffected + totalExonerated + totalTaxed + totalExportation, 2)
  result.total_igv = parseFloat(totalIgv.toFixed(2))
  result.total_plastic_bag_taxes = parseFloat(totalPlasticBagTaxes.toFixed(2))
  result.total_taxes = round(totalIgv + totalPlasticBagTaxes, 2)
  result.total = parseFloat((total + totalPlasticBagTaxes).toFixed(2))

  return result
}
