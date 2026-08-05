/**
 * Cálculo fiscal a nivel de línea y documento (POS / comprobantes).
 * Port de functions_2.js (legacy Vue 2). Funciones PURAS, sin estado reactivo.
 *
 * `calculateRowItem(row, pigv)` — calcula IGV/ISC/valor/descuentos de una línea.
 * `calculateTotal(form)`       — agrega los totales del documento a partir de sus items.
 *
 * Ambas dependen solo de los helpers del propio paquete.
 */
import { round, getAmountFromInputDiscount } from './tax-engine.js'

// ─── calculateRowItem ────────────────────────────────────────────────
export function calculateRowItem (rowOld, pigv) {
  const unitPriceInit = rowOld.unit_price ?? rowOld.unit_price_init ?? 0
  const hasIsc = rowOld.has_isc
  const percentageIgv = (pigv < 1 ? pigv * 100 : pigv) // Accept both 0.18 and 18

  const row = {
    index: rowOld.index,
    id: rowOld.id,
    item_id: rowOld.item_id ?? rowOld.item?.id,
    name: rowOld.name,
    item: rowOld.item ?? rowOld,
    unit_type_id: rowOld.unit_type_id,
    currency_type_id: rowOld.currency_type_id,
    quantity: parseFloat(rowOld.quantity) || 1,
    unit_value_init: 0,
    unit_value: 0,
    unit_price_init: parseFloat(unitPriceInit),
    unit_price: parseFloat(unitPriceInit),
    affectation_igv_type_id: rowOld.affectation_igv_type_id,
    total_base_igv: 0,
    percentage_igv: percentageIgv,
    total_igv: 0,
    system_isc_type_id: hasIsc ? rowOld.system_isc_type_id : null,
    total_base_isc: 0,
    percentage_isc: hasIsc ? parseFloat(rowOld.percentage_isc) || 0 : 0,
    total_isc: 0,
    total_base_other_taxes: 0,
    percentage_other_taxes: 0,
    total_other_taxes: 0,
    total_plastic_bag_taxes: 0,
    total_taxes: 0,
    price_type_id: '01',
    total_value: 0,
    total_discount: 0,
    total_charge: 0,
    total: 0,
    attributes: rowOld.attributes || [],
    charges: rowOld.charges || [],
    discounts: rowOld.discounts || [],
    warehouse_id: rowOld.warehouse_id,
    name_product_pdf: rowOld.name_product_pdf,
    is_set: rowOld.is_set,
    calculate_quantity: rowOld.calculate_quantity,
    exchange_points: rowOld.exchange_points,
    quantity_of_points: rowOld.quantity_of_points,
    used_points_for_exchange: rowOld.used_points_for_exchange,
    has_igv: rowOld.has_igv,
    has_plastic_bag_taxes: rowOld.has_plastic_bag_taxes,
    amount_plastic_bag_taxes: rowOld.amount_plastic_bag_taxes,
    original_affectation_igv_type_id: rowOld.original_affectation_igv_type_id,
    // Display fields
    image_url: rowOld.image_url,
    internal_id: rowOld.internal_id,
    currency_type_symbol: rowOld.currency_type_symbol,
    sets: rowOld.sets || [],
    // For precision
    total_value_without_rounding: 0,
    total_igv_without_rounding: 0,
    total_without_rounding: 0,
    activate_discount_on_discount: rowOld.activate_discount_on_discount || false,
    // Descuento simple del POS (para mostrar en UI)
    discount_percentage:  rowOld.discount_percentage  ?? 0,
    discount_amount:      rowOld.discount_amount      ?? 0,
    discount_type:        rowOld.discount_type        ?? 'percentage',
    original_unit_price:  rowOld.original_unit_price  ?? parseFloat(unitPriceInit),
  }

  // Calculate unit_value (price without IGV)
  let unitValue = row.unit_price
  if (row.affectation_igv_type_id === '10') {
    unitValue = parseFloat((row.unit_price / (1 + percentageIgv / 100)).toFixed(8))
  }
  row.unit_value_init = unitValue
  row.unit_value = unitValue

  let totalPricePartial = parseFloat((unitPriceInit * row.quantity).toFixed(2))
  let totalValuePartial = parseFloat((unitValue * row.quantity).toFixed(2))

  // ── Discounts ──
  let discountBase = 0

  if (row.discounts && row.discounts.length > 0) {
    let auxBase = totalValuePartial
    let auxPrice = totalPricePartial
    row.discounts.forEach((discount) => {
      if ((parseFloat(discount.percentage) > 0) || (parseFloat(discount.amount_base) > 0)) {
        if (discount.is_amount) {
          if (discount.discount_type && discount.discount_type.base) {
            discount.percentage = parseFloat(discount.amount_base) / totalPricePartial * 100
            discount.factor = round(discount.percentage / 100, 5)
            discount.base = round(auxBase, 2)
            discount.amount = round(discount.base * discount.factor, 2)
            discountBase += parseFloat(discount.amount_base)
            if (row.activate_discount_on_discount) {
              auxBase = discount.base - discount.amount
            }
          } else {
            const auxTotalLine = row.unit_price * row.quantity
            discount.base = round(auxTotalLine, 2)
            discount.amount = getAmountFromInputDiscount(discount)
            discount.percentage = round(100 * (parseFloat(discount.amount) / parseFloat(discount.base)), 2)
            discount.factor = round(discount.percentage / 100, 5)
          }
        } else {
          if (discount.discount_type && discount.discount_type.base) {
            discount.percentage = parseFloat(discount.percentage)
            discount.factor = round(discount.percentage / 100, 5)
            discount.base = round(auxBase, 2)
            discount.amount = round(discount.base * discount.factor, 2)
            discount.amount_base = round(auxPrice * discount.factor, 2)
            discountBase += discount.amount_base
            if (row.activate_discount_on_discount) {
              auxPrice -= discount.amount_base
              auxBase -= discount.amount
            }
          } else {
            const auxTotalLine = row.unit_price * row.quantity
            discount.factor = round(discount.percentage / 100, 5)
            discount.amount = round(auxTotalLine * discount.factor, 2)
            discount.base = round(auxTotalLine, 2)
          }
        }
      }
    })
  }

  // ── Tax Calculations ──
  let totalCharge = 0
  let totalIsc = 0
  let totalOtherTaxes = 0
  let totalIgv = totalPricePartial - totalValuePartial
  let totalDiscount = discountBase
  let totalPartial = totalPricePartial - totalDiscount

  if (totalDiscount > 0) {
    row.unit_price = parseFloat((totalPartial / row.quantity).toFixed(6))
    if (row.affectation_igv_type_id === '10') {
      totalIgv = totalPartial / (1 + percentageIgv / 100) * (percentageIgv / 100)
    }
    if (row.affectation_igv_type_id === '20') totalIgv = 0
    if (row.affectation_igv_type_id === '30') totalIgv = 0
    totalValuePartial = totalPartial - totalIgv
  }

  row.unit_value = parseFloat((totalValuePartial / row.quantity).toFixed(6))

  const totalBaseIgv = totalValuePartial
  let totalPlasticBagTaxes = 0

  if (rowOld.has_plastic_bag_taxes) {
    const amountPBT = rowOld.amount_plastic_bag_taxes ?? rowOld.item?.amount_plastic_bag_taxes ?? 0
    totalPlasticBagTaxes = round(row.quantity * amountPBT, 1)
    row.total_plastic_bag_taxes = totalPlasticBagTaxes
  }

  const totalTaxes = totalIgv + totalIsc + totalOtherTaxes + totalPlasticBagTaxes
  let total = totalValuePartial + totalTaxes

  row.total_charge = round(totalCharge, 2)
  row.total_discount = round(totalDiscount, 2)
  row.total_value = round(totalValuePartial, 2)
  row.total_base_igv = round(totalBaseIgv, 2)
  row.total_igv = round(totalIgv, 2)
  row.total_taxes = round(totalTaxes, 2)
  row.total = round(total, 2)

  // Free items (not in [10, 20, 30, 40])
  if (!['10', '20', '30', '40'].includes(row.affectation_igv_type_id)) {
    row.price_type_id = '02'
    row.unit_value = 0
    row.total = totalPlasticBagTaxes
  }

  return row
}

// ─── calculateTotal ──────────────────────────────────────────────────
export function calculateTotal (form) {
  let totalDiscount = 0, totalCharge = 0
  let totalExportation = 0, totalTaxed = 0, totalExonerated = 0
  let totalUnaffected = 0, totalFree = 0, totalIgv = 0
  let totalValue = 0, total = 0, totalPlasticBagTaxes = 0
  let totalIgvFree = 0, totalBaseIsc = 0, totalIsc = 0

  for (const row of form.items) {
    totalDiscount += parseFloat(row.total_discount) || 0
    totalCharge += parseFloat(row.total_charge) || 0

    const tv = parseFloat(row.total_value_without_rounding || row.total_value) || 0

    if (row.affectation_igv_type_id === '10') {
      totalTaxed += tv
    }

    if (row.affectation_igv_type_id === '20') {
      totalExonerated += tv
    }

    if (['30', '32', '33', '34', '35', '36'].includes(row.affectation_igv_type_id)) {
      totalUnaffected += parseFloat(row.total_value) || 0
    }

    if (row.affectation_igv_type_id === '40') {
      totalExportation += parseFloat(row.total_value) || 0
    }

    const onerousTypes = ['10', '20', '30', '32', '33', '34', '35', '36', '40']
    if (!onerousTypes.includes(row.affectation_igv_type_id)) {
      totalFree += parseFloat(row.total_value) || 0
    }

    const igvIncludedTypes = ['10', '20', '21', '30', '31', '32', '33', '34', '35', '36', '40']
    if (igvIncludedTypes.includes(row.affectation_igv_type_id)) {
      totalIgv += parseFloat(row.total_igv_without_rounding || row.total_igv) || 0
      total += parseFloat(row.total_without_rounding || row.total) || 0
    }

    if (!['21', '37', '31'].includes(row.affectation_igv_type_id)) {
      totalValue += tv
    }

    totalPlasticBagTaxes += parseFloat(row.total_plastic_bag_taxes) || 0

    // Free items with IGV (types 11-16)
    if (['11', '12', '13', '14', '15', '16'].includes(row.affectation_igv_type_id)) {
      const unitValue = row.total_value / row.quantity
      const totalValuePartial = unitValue * row.quantity
      row.total_taxes = row.total_value - totalValuePartial + parseFloat(row.total_plastic_bag_taxes)
      row.total_igv = totalValuePartial * (row.percentage_igv / 100)
      row.total_base_igv = totalValuePartial
      totalValue -= row.total_value
      totalIgvFree += row.total_igv
      total += parseFloat(row.total)
    }

    // ISC
    totalIsc += parseFloat(row.total_isc) || 0
    totalBaseIsc += parseFloat(row.total_base_isc) || 0
  }

  const totalTaxes = round(totalIgv + totalIsc + totalPlasticBagTaxes, 2)

  return {
    total_base_isc_init: round(totalBaseIsc, 2),
    total_isc_init: round(totalIsc, 2),
    total_igv_free_init: round(totalIgvFree, 2),
    total_exportation_init: round(totalExportation, 2),
    total_taxed_init: round(totalTaxed, 2),
    total_exonerated_init: round(totalExonerated, 2),
    total_unaffected_init: round(totalUnaffected, 2),
    total_free_init: round(totalFree, 2),
    total_igv_init: round(totalIgv, 2),
    total_value_init: round(totalValue, 2),
    total_taxes_init: totalTaxes,
    total_plastic_bag_taxes_init: round(totalPlasticBagTaxes, 2),
    total_init: total,

    total_base_isc: round(totalBaseIsc, 2),
    total_isc: round(totalIsc, 2),
    total_igv_free: round(totalIgvFree, 2),
    total_exportation: round(totalExportation, 2),
    total_taxed: round(totalTaxed, 2),
    total_exonerated: round(totalExonerated, 2),
    total_unaffected: round(totalUnaffected, 2),
    total_free: round(totalFree, 2),
    total_igv: round(totalIgv, 2),
    total_value: round(totalValue, 2),
    total_taxes: totalTaxes,
    total_plastic_bag_taxes: round(totalPlasticBagTaxes, 2),
    total,
  }
}
