/**
 * Adaptador motor → contrato de emisión.
 *
 * El motor nombra los importes en términos de cálculo (`subtotal`, `base`, `tax`) y el
 * comprobante los guarda con los nombres del dominio SUNAT (`total_value`,
 * `total_base_igv`, `total_igv`). Esa traducción ES lógica fiscal, no plomería: si un
 * campo se mapea mal, el documento se emite con importes incoherentes.
 *
 * Vive acá y no en cada aplicación por dos razones:
 *  1. Ya falló una vez. Con el mapeo incompleto, el total del documento salía correcto
 *     pero el IGV de cada LÍNEA quedaba en cero — y el XML se arma línea por línea, así
 *     que SUNAT recibía los tributos descuadrados.
 *  2. Los fixtures que validan contra esolutions/xml se generan con estas mismas
 *     funciones. Si la traducción viviera duplicada en la app, el test estaría validando
 *     una copia y no el camino real.
 *
 * Lo que NO va acá: metadata de presentación (nombre, imagen, lotes, listas de precio).
 * Eso es de cada aplicación; el adaptador devuelve solo campos de importes para que la
 * app les haga spread y agregue lo suyo.
 */

const n2 = v => Number(Number(v ?? 0).toFixed(2))

/**
 * Traduce UNA línea ya calculada por el motor a los campos de importes del comprobante.
 *
 * @param {Object} computed  línea que devuelve calculateTotals/calculateTotalsWithGlobals
 * @param {Object} [options]
 * @param {number} [options.igvRate=0.18]
 * @returns {Object} solo campos de importes — hacerle spread junto a la metadata propia
 */
export function toApiLine(computed, options = {}) {
  const igvRate = options.igvRate != null ? Number(options.igvRate) : 0.18
  const isTaxed = computed.category === 'taxed'

  return {
    unit_value: computed.unit_value,
    unit_price: computed.unit_price,
    quantity: computed.quantity,
    affectation_igv_type_id: computed.affectation_igv_type_id,
    unit_type_id: computed.unit_type_id,

    total_value: n2(computed.subtotal),
    total_base_igv: isTaxed ? n2(computed.base) : 0,
    percentage_igv: isTaxed ? n2(igvRate * 100) : 0,
    total_igv: n2(computed.tax),
    total_taxes: n2(computed.tax),
    total_charge: n2(computed.charges_no_base),
    total_discount: n2((computed.discounts_affect_base ?? 0) + (computed.discounts_no_base ?? 0)),
    total: n2(computed.total),

    // '01' = precio unitario incluye IGV; '02' = gratuita (no se cobra).
    price_type_id: computed.category === 'free' ? '02' : '01',
  }
}

/**
 * Traduce los totales del documento al contrato de emisión.
 *
 * @param {Object} calc  resultado de calculateTotalsWithGlobals
 */
export function toApiTotals(calc) {
  const t = calc.totals ?? calc.totalsPre ?? {}

  return {
    total_taxed: n2(t.total_taxed),
    total_exonerated: n2(t.total_exonerated),
    total_unaffected: n2(t.total_unaffected),
    total_exportation: n2(t.total_exportation),
    total_free: n2(t.total_free_ref),

    subtotal: n2(t.subtotal),
    total_value: n2(t.subtotal),
    total_igv: n2(t.tax),
    total: n2(t.total),
    total_pay: n2(t.total),

    total_discount: n2(t.total_discount),
    total_charge: n2(t.total_charge),
  }
}

/**
 * Filas de descuento global (cat.53) para `document_discounts`.
 *
 * Sin esto el descuento baja el total en pantalla pero no llega al comprobante: no se
 * emite el AllowanceCharge que explica por qué la suma de las líneas no da el total, y
 * SUNAT ve un documento descuadrado.
 */
export function toApiDiscounts(calc, options = {}) {
  const t = calc.totals ?? {}
  const ti = calc.totalsInit ?? {}
  const isAmount = options.discountGlobalType === '01'

  return (calc.documentAllowances ?? []).map(a => ({
    discount_id: a.reasonCode,
    name: options.name ?? 'Descuento global',
    base: n2(t.discount_charge_base ?? ti.subtotal_init),
    factor: (a.multiplierFactorNumeric || 0) / 100,
    amount: n2(a.amount),
    percentage: a.multiplierFactorNumeric || 0,
    is_amount: isAmount,
    type: options.discountGlobalType || '01',
    amount_base: isAmount ? Number(options.discountGlobalAmount || 0) : 0,
  }))
}

/**
 * Documento completo listo para emitir: líneas + totales + descuentos globales.
 * Es lo que se serializa como fixture para validar contra esolutions/xml.
 */
export function toApiDocument(calc, options = {}) {
  return {
    ...toApiTotals(calc),
    items: (calc.items ?? []).map(line => toApiLine(line, options)),
    discounts: toApiDiscounts(calc, options),
  }
}
