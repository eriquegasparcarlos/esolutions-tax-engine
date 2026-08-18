/**
 * peru_billing_totals_all.js
 * ------------------------------------------------------------------
 * Motor de totales FE Perú con:
 *  - Normalización precio↔valor (trabajo interno en unit_value).
 *  - Cálculo por ítem (descuentos/cargos: afectan base / no base).
 *  - Globales declarativos (Cat.53/55) con dos alcances:
 *      * 'taxed-only' (estricto fiscal): ajusta solo BG+IGV.
 *      * 'all' (proporcional comercial): ajusta también exonerado/inafecto/exportación.
 *  - Anti-penny por ítem (respetando precio UI) y a nivel documento
 *    (IGV absorbe el centavo si hiciera falta).
 *  - Gratuitos:
 *      * 11–17 (gravado gratuito) → IGV informativo por línea y total: `igv_free`.
 *      * 21 (exonerado TF), 31–37 (inafecto TF) → totales monetarios 0; se acumula valor referencial.
 *  - NUEVO: cuando existen descuentos/recargos globales, el total final
 *    se calcula con un **factor único** sobre el **subtotal PRE**,
 *    evitando desviaciones (p.ej. 211 → 10% desc = 189.90 exacto).
 *
 * Exporta:
 *  - normalizeItemPricing(item, igvRate)
 *  - projectItemToDocCurrency(item, docCurrencyId, rate, igvRate)
 *  - calculateTotals(items, options)
 *  - applyGlobalDiscountAffectsBase(input)       // usado por calculateTotalsWithGlobals
 *  - calculateTotalsWithGlobals(items, options)  // orquestador recomendado
 *  - buildBackendPayload(calcResult)
 */

const money = (v) => Number((Number(v)).toFixed(2));

//////////////////////////////
// Utilidades de precisión
//////////////////////////////
const Decimal = (() => {
  const cfg = {mathScale: 6, moneyScale: 2, roundHalfUp: true};
  // const pow10 = (n) => Math.pow(10, n);
  const toScaled = (v, s = cfg.mathScale) => Math.round(Number(v) * Math.pow(10, s));
  const fromScaled = (sv, s = cfg.mathScale) => sv / Math.pow(10, s);
  const addS = (a, b) => a + b;
  const subS = (a, b) => a - b;
  const mulS = (a, b, s = cfg.mathScale) => Math.round((a * b) / Math.pow(10, s));
  const divS = (a, b, s = cfg.mathScale) => Math.round((a * Math.pow(10, s)) / b);
  const roundMoney = (v, m = cfg.moneyScale) => Math.round(Number(v) * Math.pow(10, m)) / Math.pow(10, m);
  const setConfig = (o = {}) => {
    if (o.mathScale != null) cfg.mathScale = o.mathScale;
    if (o.moneyScale != null) cfg.moneyScale = o.moneyScale;
    if (o.roundHalfUp != null) cfg.roundHalfUp = o.roundHalfUp;
  };
  return {cfg, toScaled, fromScaled, addS, subS, mulS, divS, roundMoney, setConfig};
})();

//////////////////////////////
// Afectaciones IGV (Cat. 07)
//////////////////////////////
const Affectation = {
  _FREE_CODES: new Set(['11', '12', '13', '14', '15', '16', '17', '21', '31', '32', '33', '34', '35', '36', '37']),
  isTaxed(code) {
    return String(code) === '10';
  },
  isFree(code) {
    return this._FREE_CODES.has(String(code));
  },
  isExonerated(code) {
    return String(code) === '20';
  }, // 21 ya es FREE
  isUnaffected(code) {
    return String(code) === '30';
  }, // 31–37 FREE
  isExportation(code) {
    return String(code) === '40';
  },
  isFreeTaxed(code) {
    return ['11', '12', '13', '14', '15', '16', '17'].includes(String(code));
  },
  category(code) {
    if (this.isFree(code)) return 'free';
    if (this.isTaxed(code)) return 'taxed';
    if (this.isExonerated(code)) return 'exonerated';
    if (this.isUnaffected(code)) return 'unaffected';
    if (this.isExportation(code)) return 'exportation';
    return 'unaffected';
  }
};

//////////////////////////////////////
// Builders UBL-like (53 descuentos / 55 cargos)
//////////////////////////////////////
function buildDiscountLine(amount, percent = null, affectsBase = true, reasonCode = null) {
  const code = reasonCode || (affectsBase ? '02' : '03'); // 02 afecta base, 03 no base
  return {chargeIndicator: false, id: '53', reasonCode: code, amount: Number(amount), multiplierFactorNumeric: percent != null ? Number(percent) : null};
}

function buildChargeLine(amount, percent = null, affectsBase = true, reasonCode = null) {
  const code = reasonCode || (affectsBase ? '50' : '51'); // 50 afecta base, 51 no base
  return {chargeIndicator: true, id: '55', reasonCode: code, amount: Number(amount), multiplierFactorNumeric: percent != null ? Number(percent) : null};
}

function splitOpsByType(discounts = [], charges = []) {
  const ds = (discounts || []).map(d => ({...d, chargeIndicator: false, charge: false}));
  const cs = (charges || []).map(c => ({...c, chargeIndicator: true, charge: true}));
  return ds.concat(cs);
}

function applyOps(valueScaled, ops = [], affectBase = true) {
  let current = valueScaled;
  let totalAppliedScaled = 0;
  for (const op of (ops || [])) {
    if ((op.affectsBase ?? true) !== affectBase) continue;
    const isPercent = (op.type || 'amount') === 'percent';
    const v = Number(op.value || 0);
    const deltaScaled = isPercent ? Math.round(current * (v / 100)) : Decimal.toScaled(v);
    if (op.charge === true || op.chargeIndicator === true) {
      current = Decimal.addS(current, deltaScaled);
      totalAppliedScaled = Decimal.addS(totalAppliedScaled, deltaScaled);
    } else {
      const applied = Math.min(deltaScaled, current);
      current = Decimal.subS(current, applied);
      totalAppliedScaled = Decimal.addS(totalAppliedScaled, applied);
    }
  }
  return {newValueScaled: current, appliedScaled: totalAppliedScaled};
}

//////////////////////////////////////
// Normalización de precio ↔ valor
//////////////////////////////////////
export function normalizeItemPricing(item, igvRate = 0.18) {
  const out = {...item};
  out.item_id = out.item_id ?? out.id ?? null;
  out.name = out.name ?? '';
  out.unit_type_id = out.unit_type_id ?? 'NIU';
  out.currency_id = out.currency_id ?? item.currency_type_id ?? 'PEN';

  if (out.unit_price != null) {
    const p2 = Number(Number(out.unit_price).toFixed(2));
    out._input_unit_price_native = p2;
    out._input_unit_price_doc = p2; // si no hay proyección de moneda
  }

  if (out.pricing_mode === 'price' && out.unit_price != null && Affectation.isTaxed(out.affectation_igv_type_id)) {
    const unitPriceScaled = Decimal.toScaled(out.unit_price);
    const factorScaled = Decimal.toScaled(1 + igvRate);
    const unitValueScaled = Decimal.divS(unitPriceScaled, factorScaled);
    out.unit_value = Number((Decimal.fromScaled(unitValueScaled)).toFixed(6));
  } else if (out.unit_value == null && out.unit_price != null) {
    out.unit_value = Number(out.unit_price);
  }
  return out;
}

function convertMoney(val, from, to, rate) {
  if (from === to) return val;
  if (!rate || rate <= 0) return val;
  if (from === 'PEN' && to === 'USD') return val / rate;
  if (from === 'USD' && to === 'PEN') return val * rate;
  return val;
}

export function projectItemToDocCurrency(item, docCurrencyId, rate, igvRate = 0.18) {
  const it = {...item};
  const from = it.currency_id || 'PEN';
  const to = docCurrencyId || 'PEN';

  if (it.unit_value != null) {
    const uvDoc = convertMoney(it.unit_value, from, to, rate);
    it.unit_value = Number(Number(uvDoc).toFixed(6));
  }

  let unitPriceDocRaw = it.unit_value;
  if (Affectation.isTaxed(it.affectation_igv_type_id)) {
    unitPriceDocRaw = it.unit_value * (1 + igvRate);
  }

  if (it.pricing_mode === 'price' && it._input_unit_price_native != null) {
    const uiDoc = convertMoney(it._input_unit_price_native, from, to, rate);
    it._input_unit_price_doc = Number(Decimal.roundMoney(uiDoc));
  } else {
    it._input_unit_price_doc = null;
  }

  it.unit_price = Number(Decimal.roundMoney(unitPriceDocRaw));
  it.currency_id = to;
  return it;
}

/////////////////////////////////////////////////////////
// Cálculo por ítem (con reconciliación por precio UI)
/////////////////////////////////////////////////////////
function computeItem(item, igvRate) {
  const qtyScaled = Decimal.toScaled(item.quantity || 0);

  // 1) unit_value (sin IGV)
  let unitValueScaled;
  if (item.pricing_mode === 'price' && item.unit_price != null && Affectation.isTaxed(item.affectation_igv_type_id)) {
    const unitPriceScaled = Decimal.toScaled(item.unit_price);
    const factor = Decimal.toScaled(1 + igvRate);
    unitValueScaled = Decimal.divS(unitPriceScaled, factor);
  } else if (item.unit_value != null) {
    unitValueScaled = Decimal.toScaled(item.unit_value);
  } else if (item.unit_price != null) {
    unitValueScaled = Decimal.toScaled(item.unit_price);
  } else {
    unitValueScaled = Decimal.toScaled(0);
  }

  // 2) Base inicial
  const baseInicialScaled = Decimal.mulS(unitValueScaled, qtyScaled);

  // 3) Ops por ítem
  const ops = splitOpsByType(item.discounts, item.charges);

  // 4) Afectan base
  const {newValueScaled: baseAfectaScaled, appliedScaled: appliedAfectaScaled} = applyOps(baseInicialScaled, ops, true);

  // 5) IGV (gravado)
  const cat = Affectation.category(item.affectation_igv_type_id);
  let taxScaled = 0;
  if (cat === 'taxed') taxScaled = Math.round(baseAfectaScaled * igvRate);

  // 6) No afectan base (post IGV)
  const totalParcialScaled = Decimal.addS(baseAfectaScaled, taxScaled);
  const {newValueScaled: totalFinalScaled, appliedScaled: appliedNoBaseScaled} = applyOps(totalParcialScaled, ops, false);

  // 7) Precio unitario de presentación
  const unitValue = Decimal.fromScaled(unitValueScaled);
  const unitPriceOutRaw = (cat === 'taxed') ? (unitValue * (1 + igvRate)) : unitValue;
  const uiPriceForShow = (item._input_unit_price_doc ?? item._input_unit_price_native);
    const unit_price_show = (item.pricing_mode === 'price' && uiPriceForShow != null)
    ? money(uiPriceForShow)
    : money(Decimal.roundMoney(unitPriceOutRaw));

  // 8) Reconciliación por ítem (si no hay ops por ítem y es gravado con precio UI)
  const noItemOps = !(item.discounts?.length || item.charges?.length);
  let totalPresent = Decimal.roundMoney(Decimal.fromScaled(totalFinalScaled));
  const uiPrice = (item._input_unit_price_doc ?? item._input_unit_price_native);
  if (item.pricing_mode === 'price' && uiPrice != null && noItemOps && cat === 'taxed') {
    totalPresent = (item.quantity || 0) * Number(uiPrice);
  }
  totalPresent = money(totalPresent);

  // 9) Coherencia visual base/tax desde totalPresent
  let basePresent = (cat === 'taxed') ? (totalPresent / (1 + igvRate)) : totalPresent;
  let taxPresent  = (cat === 'taxed') ? (totalPresent - basePresent) : 0;
  basePresent = money(basePresent);
  taxPresent  = money(taxPresent);

  // 10) UBL-like referenciales
  const itemAllowances = [];
  const itemCharges = [];
  for (const op of ops) {
    const percent = (op.type === 'percent') ? op.value : null;
    let refAmount = 0;
    if (op.affectsBase ?? true) {
      refAmount = op.type === 'percent' ? Decimal.fromScaled(baseInicialScaled) * (op.value / 100) : Number(op.value);
      if (op.charge) itemCharges.push(buildChargeLine(Decimal.roundMoney(refAmount), percent, true, op.reasonCode));
      else itemAllowances.push(buildDiscountLine(Decimal.roundMoney(refAmount), percent, true, op.reasonCode));
    } else {
      refAmount = op.type === 'percent' ? Decimal.fromScaled(totalParcialScaled) * (op.value / 100) : Number(op.value);
      if (op.charge) itemCharges.push(buildChargeLine(Decimal.roundMoney(refAmount), percent, false, op.reasonCode));
      else itemAllowances.push(buildDiscountLine(Decimal.roundMoney(refAmount), percent, false, op.reasonCode));
    }
  }

  // 11) Salida
  // IMPORTANTE: subtotal debe ser la base imponible (sin IGV) según SUNAT
  // - Para gravados: solo la base (sin IGV)
  // - Para exonerados/inafectos/exportación: el total (que ya no tiene IGV)
  // - Para gratuitos: 0
  const itemSubtotal = (cat === 'taxed') ? basePresent : totalPresent;
  
  const out = {
    item_id: item.item_id ?? item.id ?? null,
    name: item.name ?? '',
    description: item.description ?? '',
    unit_type_id: item.unit_type_id ?? 'NIU',
    currency_id: item.currency_id ?? 'PEN',
    unit_value: Number(unitValue.toFixed(6)),
    unit_price: unit_price_show,
    quantity: Number((item.quantity || 0)),
    base: basePresent,
    tax: taxPresent,
    subtotal: itemSubtotal, // Base imponible (sin IGV) según SUNAT
    total: totalPresent,    // Total con IGV (para productos gravados)
    itemAllowances,
    itemCharges,
    category: cat,
    free_of_charge: (cat === 'free'),
    baseInicial: Decimal.roundMoney(Decimal.fromScaled(baseInicialScaled)),
    discounts_affect_base: Decimal.roundMoney(Decimal.fromScaled(appliedAfectaScaled)),
    discounts_no_base: Decimal.roundMoney(Decimal.fromScaled(appliedNoBaseScaled)),
    affectation_igv_type_id: String(item.affectation_igv_type_id),
    affectation_igv_type_name: String(item.affectation_igv_type_name),
    _taxScaled: taxScaled,
    _totalScaled: totalFinalScaled,
    _taxResidualScaled: (taxScaled % 1) || (totalFinalScaled % 1),
  };

  // IGV informativo para gratuitos gravados (11–17)
  out.igv_free = 0;
  if (Affectation.isFreeTaxed(item.affectation_igv_type_id)) {
    const baseRef = Number(out.baseInicial || 0);
    out.igv_free = Number((baseRef * igvRate).toFixed(2));
  }

  // Líneas FREE → totales 0
  if (cat === 'free') {
    out.tax = 0;
    out.total = 0;
    out.subtotal = 0;
  }

  return out;
}

////////////////////////////////////////////////////////////
// Cálculo documento PRE (sin globales): NO TOCAR
////////////////////////////////////////////////////////////
export function calculateTotals(items = [], options = {}) {
  const igvRate = options.igvRate != null ? Number(options.igvRate) : 0.18;
  Decimal.setConfig({moneyScale: options.moneyScale ?? 2, mathScale: options.mathScale ?? 6, roundHalfUp: options.roundHalfUp ?? true});

  const resultItems = [];
  let uiSum = 0;
  const candidates = [];
  let total_exonerated = 0, total_unaffected = 0, total_exportation = 0;
  let total_free_ref = 0, total_igv_free = 0;
  let taxable_base_scaled = 0, tax_scaled = 0, subtotal_scaled = 0;

  for (const it of items) {
    const computed = computeItem(it, igvRate);
    resultItems.push(computed);

    const isUIPrice = (it.pricing_mode === 'price' && computed.category !== 'free' && !(it.discounts?.length || it.charges?.length));
    if (isUIPrice) {
      const uiPrice = (it._input_unit_price_doc ?? it._input_unit_price_native);
      if (uiPrice != null) {
        uiSum = money(uiSum + money((it.quantity || 0) * Number(uiPrice)));
        candidates.push({idx: resultItems.length - 1, weight: computed._taxResidualScaled ?? 0});
      }
    }

    // IMPORTANTE: El subtotal según SUNAT debe ser la suma de las bases imponibles (sin IGV)
    // - Para gravados: solo la base (sin IGV)
    // - Para exonerados/inafectos/exportación: el total (que ya no tiene IGV)
    // - Para gratuitos: 0 (no se suma)
    if (computed.category !== 'free') {
      subtotal_scaled += Decimal.toScaled(computed.subtotal);
    }

    switch (computed.category) {
      case 'taxed':
        taxable_base_scaled += Decimal.toScaled(computed.base);
        tax_scaled += Decimal.toScaled(computed.tax);
        break;
      case 'exonerated':
        total_exonerated += computed.total;
        break;
      case 'unaffected':
        total_unaffected += computed.total;
        break;
      case 'exportation':
        total_exportation += computed.total;
        break;
      case 'free':
        total_free_ref += computed.baseInicial;
        if (Affectation.isFreeTaxed(it.affectation_igv_type_id)) total_igv_free += Number(computed.igv_free || 0);
        break;
    }
  }

  // Anti-penny documental (respetar suma UI)
  // Nota: uiSum es el total con IGV (para productos gravados), pero el subtotal debe ser sin IGV
  // Para reconciliación, comparamos con el total (que incluye IGV para gravados)
  const totalCalc = resultItems.filter(i => i.category !== 'free').reduce((acc, i) => acc + Decimal.toScaled(i.total), 0);
  const totalCalcMoney = Decimal.roundMoney(Decimal.fromScaled(totalCalc));
  const delta = Number((uiSum - totalCalcMoney).toFixed(2));
  let reconciliation_item_index = null;
  if (Math.abs(delta) === 0.01 && options.reconcileWithUiPrices !== false && candidates.length) {
    candidates.sort((a, b) => b.weight - a.weight);
    const k = candidates[0].idx;
    reconciliation_item_index = k;
    resultItems[k].total = Number((resultItems[k].total + delta).toFixed(2));
    if (resultItems[k].category === 'taxed') {
      const newTax = Number((resultItems[k].tax + delta).toFixed(2));
      const newBase = Number((resultItems[k].total - newTax).toFixed(2));
      resultItems[k].tax = newTax;
      resultItems[k].base = newBase;
      resultItems[k].subtotal = newBase; // Subtotal es la base (sin IGV)
    }
    // Recalcular subtotal después de la reconciliación
    subtotal_scaled = resultItems.filter(i => i.category !== 'free').reduce((acc, i) => acc + Decimal.toScaled(i.subtotal), 0);
  }

  // El total del documento debe ser: subtotal + IGV
  // subtotal ya incluye: base gravada + exonerados + inafectos + exportación (sin IGV)
  // total = subtotal + IGV
  const total_scaled = Decimal.addS(subtotal_scaled, tax_scaled);
  
  const totalsPre = {
    total_taxed: Decimal.roundMoney(Decimal.fromScaled(taxable_base_scaled)),
    total_exonerated: Number(total_exonerated.toFixed(2)),
    total_unaffected: Number(total_unaffected.toFixed(2)),
    total_exportation: Number(total_exportation.toFixed(2)),
    total_free_ref: Number(total_free_ref.toFixed(2)),
    total_igv_free: Number(total_igv_free.toFixed(2)),
    subtotal: Decimal.roundMoney(Decimal.fromScaled(subtotal_scaled)), // Suma de bases imponibles (sin IGV)
    taxable_base: Decimal.roundMoney(Decimal.fromScaled(taxable_base_scaled)),
    tax: Decimal.roundMoney(Decimal.fromScaled(tax_scaled)),
    total: Decimal.roundMoney(Decimal.fromScaled(total_scaled)), // subtotal + IGV
    reconciliation_delta_ui: delta,
    reconciliation_item_index,
    ui_sum_before_reconcile: uiSum
  };

  return {items: resultItems, totalsPre, meta: {igvRate, moneyScale: Decimal.cfg.moneyScale, mathScale: Decimal.cfg.mathScale}};
}

////////////////////////////////////////////////////////////////
// NUEVO motor de globales con FACTOR ÚNICO de subtotal PRE
////////////////////////////////////////////////////////////////
export function applyGlobalDiscountAffectsBase(input) {
  const igvRate = input.igvRate ?? 0.18;
  const affectBaseScopeAll = !!input.affectBaseScopeAll; // true => proporcional en todas las líneas
  Decimal.setConfig({moneyScale: input.moneyScale ?? 2, mathScale: input.mathScale ?? 6});

  // Valores PRE (en dinero)
  // IMPORTANTE: subtotalPRE ahora es la suma de bases imponibles (sin IGV)
  // - baseTaxedPRE: base gravada (sin IGV)
  // - otherPRE: exonerados + inafectos + exportación (sin IGV)
  // - subtotalPRE = baseTaxedPRE + otherPRE
  const baseTaxedPRE = Number(input.baseTaxed || 0);   // BG (sin IGV)
  const subtotalPRE = Number(input.subtotal || 0);    // suma de bases imponibles (sin IGV)
  const otherPRE = Number((subtotalPRE - baseTaxedPRE).toFixed(2)); // exo+inaf+exp (sin IGV)

  // Construir lista de operaciones
  const discounts = input.discounts || [];
  const charges = input.charges || [];

  // Calcular FACTOR ÚNICO sobre SUBTOTAL PRE:
  //  - Si la op es 'amount' y afecta base, previamente (desde el orquestador) se convierte a 'percent'
  //    respecto al subtotal PRE para exactitud del monto total.
  //  - Aquí sumamos porcentajes (modelo aditivo): totalFactor = 1 + Σcharges(%) - Σdiscounts(%)
  //    (Si quisieras compuesto, cambia a producto; requisito actual: aditivo.)
  let pctDiscounts = 0, pctCharges = 0;
  const allowances53 = [], charges55 = [];

  for (const d of discounts) {
    const p = (d.type === 'percent') ? Number(d.value || 0) : 0;
    pctDiscounts += p;
    // Línea UBL referencial (sobre subtotal PRE)
    const refAmount = Decimal.roundMoney(subtotalPRE * (p / 100));
    allowances53.push(buildDiscountLine(refAmount, p, !!d.affectsBase, d.reasonCode));
  }
  for (const c of charges) {
    const p = (c.type === 'percent') ? Number(c.value || 0) : 0;
    pctCharges += p;
    const refAmount = Decimal.roundMoney(subtotalPRE * (p / 100));
    charges55.push(buildChargeLine(refAmount, p, !!c.affectsBase, c.reasonCode));
  }

  const totalFactor = 1 + (pctCharges / 100) - (pctDiscounts / 100);

  // totalPRE: total con IGV antes del descuento (base del factor único)
  // Si no se pasa explícitamente, se reconstruye como subtotalPRE + IGV original
  const totalPRE = Number(input.total != null ? input.total : (subtotalPRE + Number(input.tax || 0)));

  // 1) NUEVO TOTAL con IGV por FACTOR ÚNICO
  //    Partir del total con IGV evita errores de redondeo que surgen al aplicar
  //    el factor sobre la base sin IGV y luego recalcular el IGV encima.
  const newTotal = Decimal.roundMoney(totalPRE * totalFactor);

  // 2) Reproyección de "otros" (exonerado + inafecto + exportación, sin IGV)
  let newOther = otherPRE;

  if (affectBaseScopeAll) {
    newOther = Decimal.roundMoney(otherPRE * totalFactor);
  }

  // 3) Extraer base e IGV desde el nuevo total con IGV
  //    newTaxedWithIGV = porción gravada del nuevo total (base + IGV)
  let newTaxedWithIGV = Decimal.roundMoney(newTotal - newOther);
  let newBaseTaxed    = Decimal.roundMoney(newTaxedWithIGV / (1 + igvRate));
  let newTax          = Decimal.roundMoney(newTaxedWithIGV - newBaseTaxed);

  // newSubtotal = suma de bases sin IGV (para totals.subtotal y totalFinal = newSubtotal + newTax)
  const newSubtotal = Decimal.roundMoney(newBaseTaxed + newOther);

  // 4) Reconciliación final: forzar que newSubtotal+newTax = newTotal (ajusta preferentemente IGV)
  let sumNow = Decimal.roundMoney(newBaseTaxed + newTax + newOther);
  let delta = Number((newTotal - sumNow).toFixed(2)); // -0.01 | 0 | +0.01

  if (delta !== 0) {
    const taxCandidate = Number((newTax + delta).toFixed(2));
    if (taxCandidate >= 0) {
      newTax = taxCandidate;
    } else {
      newBaseTaxed = Number((newBaseTaxed + delta).toFixed(2));
      if (newBaseTaxed < 0) newBaseTaxed = 0;
    }
  }

  return {
    newBaseTaxed,
    newTax,
    newSubtotal,
    allowances53,
    charges55,
    sums: {
      // Totales de descuentos/cargos globales (referenciales sobre subtotal PRE)
      discAffBase: Decimal.roundMoney(subtotalPRE * (pctDiscounts / 100)), // suma descuentos %
      chgAffBase: Decimal.roundMoney(subtotalPRE * (pctCharges / 100)),   // suma cargos %
      discNoBase: 0,
      chgNoBase: 0,
    }
  };
}

//////////////////////////////////////////////////////////////
// Orquestador (ítems + globales): convierte montos→porcentaje
//////////////////////////////////////////////////////////////
export function calculateTotalsWithGlobals(items = [], options = {}) {
  const res = calculateTotals(items, options);

  // Si NO hay globales → devolver tal cual (NO tocar esta ruta)
  const hasDeclarative =
    (options.discount_global_id && options.discount_global_amount) ||
    (options.charge_global_id && options.charge_global_amount) ||
    (options.globalDiscounts && options.globalDiscounts.length) ||
    (options.globalCharges && options.globalCharges.length);

  if (!hasDeclarative) {
    return {
      items: res.items,
      totalsInit: {
        total_taxed_init: res.totalsPre.total_taxed,
        total_exonerated_init: res.totalsPre.total_exonerated,
        total_unaffected_init: res.totalsPre.total_unaffected,
        total_exportation_init: res.totalsPre.total_exportation,
        total_free_ref: res.totalsPre.total_free_ref,
        total_igv_free: res.totalsPre.total_igv_free,
        subtotal_init: res.totalsPre.subtotal,
        taxable_base_init: res.totalsPre.taxable_base,
        tax_init: res.totalsPre.tax,
        total_init: res.totalsPre.total,
        reconciliation_delta_ui: res.totalsPre.reconciliation_delta_ui,
        reconciliation_item_index: res.totalsPre.reconciliation_item_index,
        ui_sum_before_reconcile: res.totalsPre.ui_sum_before_reconcile,
      },
      totals: {
        total_taxed: res.totalsPre.total_taxed,
        total_exonerated: res.totalsPre.total_exonerated,
        total_unaffected: res.totalsPre.total_unaffected,
        total_exportation: res.totalsPre.total_exportation,
        total_free_ref: res.totalsPre.total_free_ref,
        total_igv_free: res.totalsPre.total_igv_free,
        subtotal: res.totalsPre.subtotal,
        taxable_base: res.totalsPre.taxable_base,
        tax: res.totalsPre.tax,
        total: res.totalsPre.total,
        global_discounts_total_affect_base: 0,
        global_discounts_total_no_base: 0,
        global_charges_total_affect_base: 0,
        global_charges_total_no_base: 0,
        total_discount_base: 0,
        total_discount_no_base: 0,
        total_discount: 0,
        total_charge_base: 0,
        total_charge_no_base: 0,
        total_charge: 0,
        discount_global_id: null,
        discount_global_type: null,
        discount_global_amount: 0,
        charge_global_id: null,
        charge_global_type: null,
        charge_global_amount: 0,
        total_detraction: 0,
        total_retention: 0,
      },
      documentAllowances: [],
      documentCharges: [],
      meta: res.meta
    };
  }

  // 1) Armar arrays desde declarativos
  const globalDiscounts = [];
  const globalCharges = [];

  function pushGlobal(arr, id, type, amount) {
    if (!id || !type || amount == null || Number(amount) === 0) return;
    const isPercent = (type === '02'); // 02 = %
    arr.push({type: isPercent ? 'percent' : 'amount', value: Number(amount), affectsBase: true, reasonCode: id});
  }

  pushGlobal(globalDiscounts, options.discount_global_id, options.discount_global_type, options.discount_global_amount);
  pushGlobal(globalCharges, options.charge_global_id, options.charge_global_type, options.charge_global_amount);

  const discounts = [...(options.globalDiscounts || []), ...globalDiscounts];
  const charges = [...(options.globalCharges || []), ...globalCharges];

  // 2) Convertir MONTO→PORCENTAJE respecto al TOTAL con IGV (no contra la base sin IGV,
  //    ya que el usuario percibe el descuento sobre el precio final que incluye IGV)
  const STpre = res.totalsPre.total || 0;
  const convertedDiscounts = discounts.map(d => (d.type === 'amount' && STpre > 0) ? {...d, type: 'percent', value: (Number(d.value) / STpre) * 100} : d);
  const convertedCharges = charges.map(c => (c.type === 'amount' && STpre > 0) ? {...c, type: 'percent', value: (Number(c.value) / STpre) * 100} : c);

  // 3) Aplicar globales
  const scopeAll = options.affectBaseScope === 'all';
  // Un descuento/cargo global puede o no afectar la base imponible (y por
  // tanto el IGV):
  //  - SÍ afecta base (default; `globalAffectsBase !== false`): factor único
  //    sobre el total con IGV + reparto DENTRO de cada línea. Este reparto se
  //    probó y se requiere para Nota de Crédito motivo 04 — sin tocar las
  //    líneas, SUNAT rechaza con 3277 (“La sumatoria del total valor de venta
  //    - operaciones gravadas de línea no corresponden al total”). Verificado
  //    enviando a SUNAT beta (2026-07-18, ver memoria descuento-global-sunat).
  //  - NO afecta base (`globalAffectsBase: false`): modelo del código 02 de
  //    catálogo 53 (“Descuento global otorgado”) tal como lo define el propio
  //    paquete esolutions/xml — ver docs/examples/FAC_02_con_descuento_global.xml
  //    y tests/fixtures/payloads/factura/FAC_02_descuento_global.json
  //    (“expect”: “ok”): base imponible, IGV e items quedan EXACTAMENTE
  //    igual; el descuento solo resta del total a pagar (PayableAmount). Es
  //    el modelo correcto para un descuento comercial sobre una venta/nota de
  //    venta/cotización normal — no confundir con un descuento POR ÍTEM
  //    (“lineal”), que es otro mecanismo (item.discounts/item.charges, ya
  //    soportado por computeItem/applyOps) y sí cambia el precio de esa línea
  //    puntual porque el usuario lo pidió explícitamente sobre ese ítem.
  const globalAffectsBase = options.globalAffectsBase !== false;

  const gl = applyGlobalDiscountAffectsBase({
    baseTaxed: res.totalsPre.taxable_base,
    tax: res.totalsPre.tax,
    subtotal: res.totalsPre.subtotal,
    total: res.totalsPre.total,       // total con IGV: base del factor único
    discounts: convertedDiscounts,
    charges: convertedCharges,
    igvRate: options.igvRate ?? 0.18,
    moneyScale: options.moneyScale ?? 2,
    mathScale: options.mathScale ?? 6,
    affectBaseScopeAll: scopeAll,
  });

  // 4) Reparto de “otros” si scopeAll (ya contemplado adentro con factor único).
  // Solo aplica si el descuento afecta base — si no, exonerado/inafecto/
  // exportación quedan tal cual (nada que reproyectar).
  let total_exonerated_post = res.totalsPre.total_exonerated;
  let total_unaffected_post = res.totalsPre.total_unaffected;
  let total_exportation_post = res.totalsPre.total_exportation;
  let otherRatio = 1;

  if (globalAffectsBase && scopeAll) {
    const otherPre = (res.totalsPre.total_exonerated || 0) + (res.totalsPre.total_unaffected || 0) + (res.totalsPre.total_exportation || 0);
    const otherPost = Number((gl.newSubtotal - (gl.newBaseTaxed + gl.newTax)).toFixed(2));
    if (otherPre > 0) {
      otherRatio = otherPost / otherPre;
      total_exonerated_post = Number((res.totalsPre.total_exonerated * otherRatio).toFixed(2));
      total_unaffected_post = Number((res.totalsPre.total_unaffected * otherRatio).toFixed(2));
      total_exportation_post = Number((res.totalsPre.total_exportation * otherRatio).toFixed(2));
    } else {
      total_exonerated_post = 0;
      total_unaffected_post = 0;
      total_exportation_post = 0;
    }
  }

  // Base/IGV/subtotal finales del documento: recalculados por factor único
  // solo si el descuento afecta base; si no, quedan en su valor PRE (el
  // descuento vive aparte, en total_discount_no_base, y solo resta del total
  // a pagar en el punto 7).
  const newBaseTaxed = globalAffectsBase ? gl.newBaseTaxed : res.totalsPre.taxable_base;
  const newTax = globalAffectsBase ? gl.newTax : res.totalsPre.tax;
  const newSubtotal = globalAffectsBase ? gl.newSubtotal : res.totalsPre.subtotal;

  // 4b) Reparto DENTRO de cada línea — solo si el descuento afecta base (ver
  // nota del punto 3). Si no afecta base, las líneas no cambian: la base
  // gravada del documento sigue siendo la suma original de líneas, así que no
  // hay nada que reconciliar.
  let distributedItems = res.items;
  if (globalAffectsBase) {
    const taxedRatio = res.totalsPre.taxable_base > 0 ? gl.newBaseTaxed / res.totalsPre.taxable_base : 1;
    distributedItems = distributeGlobalAdjustmentToLines(res.items, {
      taxedRatio,
      otherRatio: scopeAll ? otherRatio : 1,
      targetTaxedBase: gl.newBaseTaxed,
      targetTaxedTax: gl.newTax,
      targetOtherTotal: scopeAll ? Number((gl.newSubtotal - gl.newBaseTaxed).toFixed(2)) : null,
    });
  }

  // 5) Totales INIT para persistir
  const totalsInit = {
    total_taxed_init: res.totalsPre.total_taxed,
    total_exonerated_init: res.totalsPre.total_exonerated,
    total_unaffected_init: res.totalsPre.total_unaffected,
    total_exportation_init: res.totalsPre.total_exportation,
    total_free_ref: res.totalsPre.total_free_ref,
    total_igv_free: res.totalsPre.total_igv_free,
    subtotal_init: res.totalsPre.subtotal,
    taxable_base_init: res.totalsPre.taxable_base,
    tax_init: res.totalsPre.tax,
    total_init: res.totalsPre.total,
    reconciliation_delta_ui: res.totalsPre.reconciliation_delta_ui,
    reconciliation_item_index: res.totalsPre.reconciliation_item_index,
    ui_sum_before_reconcile: res.totalsPre.ui_sum_before_reconcile,
  };

  // 6) Sumas de globales (monto real del AllowanceCharge — visibles para
  // UI/almacenamiento). El criterio de base difiere según el modo:
  //  - Afecta base: sobre subtotal PRE (sin IGV) — no tocar, es lo que ya
  //    declara el AllowanceCharge de NC motivo 04 (gl.allowances53 abajo).
  //  - No afecta base: sobre el TOTAL PRE con IGV, monto y factor derivados
  //    directo del valor declarado por el usuario — mismo criterio que
  //    qpospe (discountGlobal(): `base = form.total` cuando no afecta base).
  //    Por construcción amount = base×factor siempre cuadra exacto (evita
  //    3307 "El valor de cargo/descuento global difiere de los importes
  //    consignados"), sin pasar por la conversión monto→% contra STpre que
  //    usa el otro modo (esa conversión y el AllowanceCharge subtotalPRE-based
  //    usan bases distintas entre sí — inconsistencia preexistente del modo
  //    "afecta base" que no tocamos aquí para no arriesgar NC motivo 04).
  let total_discount, total_charge, discountChargeBase;

  if (globalAffectsBase) {
    const pctDisc = convertedDiscounts.filter(d => d.type === 'percent').reduce((s, d) => s + Number(d.value || 0), 0);
    const pctChg = convertedCharges.filter(c => c.type === 'percent').reduce((s, c) => s + Number(c.value || 0), 0);
    total_discount = Decimal.roundMoney(STpre * (pctDisc / 100));
    total_charge = Decimal.roundMoney(STpre * (pctChg / 100));
    discountChargeBase = res.totalsPre.subtotal;
  } else {
    discountChargeBase = res.totalsPre.total;
    const sumRawOps = (ops) => ops.reduce((sum, op) => {
      const amt = op.type === 'percent'
        ? Decimal.roundMoney(discountChargeBase * (Number(op.value || 0) / 100))
        : Number(op.value || 0);
      return sum + amt;
    }, 0);
    total_discount = Decimal.roundMoney(sumRawOps(discounts));
    total_charge = Decimal.roundMoney(sumRawOps(charges));
  }

  // 7) Totales finales
  // Si afecta base: subtotal + IGV (ya recalculados por factor único). Si no
  // afecta base: el total PRE (con IGV, sin tocar) menos el descuento más el
  // cargo — igual que PayableAmount en FAC_02_con_descuento_global.xml.
  const totalFinal = globalAffectsBase
    ? Number((newSubtotal + newTax).toFixed(2))
    : Number((res.totalsPre.total - total_discount + total_charge).toFixed(2));

  const totals = {
    total_taxed: newBaseTaxed,
    total_exonerated: total_exonerated_post,
    total_unaffected: total_unaffected_post,
    total_exportation: total_exportation_post,
    total_free_ref: res.totalsPre.total_free_ref,
    total_igv_free: res.totalsPre.total_igv_free,
    subtotal: newSubtotal, // Suma de bases imponibles (sin IGV)
    taxable_base: newBaseTaxed,
    tax: newTax,
    total: totalFinal,
    global_discounts_total_affect_base: globalAffectsBase ? total_discount : 0,
    global_discounts_total_no_base: globalAffectsBase ? 0 : total_discount,
    global_charges_total_affect_base: globalAffectsBase ? total_charge : 0,
    global_charges_total_no_base: globalAffectsBase ? 0 : total_charge,
    total_discount_base: globalAffectsBase ? total_discount : 0,
    total_discount_no_base: globalAffectsBase ? 0 : total_discount,
    total_discount: total_discount,
    total_charge_base: globalAffectsBase ? total_charge : 0,
    total_charge_no_base: globalAffectsBase ? 0 : total_charge,
    total_charge: total_charge,
    // Base sobre la que se calcularon total_discount/total_charge — la usa
    // el caller para armar el registro `discounts[]`/`charges[]` que se
    // persiste y se manda al XML (cac:AllowanceCharge/cbc:BaseAmount).
    discount_charge_base: discountChargeBase,
    discount_global_id: options.discount_global_id ?? null,
    discount_global_type: options.discount_global_type ?? null,
    discount_global_amount: Number(options.discount_global_amount || 0),
    charge_global_id: options.charge_global_id ?? null,
    charge_global_type: options.charge_global_type ?? null,
    charge_global_amount: Number(options.charge_global_amount || 0),
    total_detraction: 0,
    total_retention: 0,
  };

  if (options.detraction?.enabled && options.detraction.rate > 0) {
    totals.total_detraction = Decimal.roundMoney(totals.total * options.detraction.rate);
  }
  if (options.retention?.enabled && options.retention.rate > 0) {
    totals.total_retention = Decimal.roundMoney(totals.total * options.retention.rate);
  }

  // documentAllowances/documentCharges: si afecta base, son las líneas UBL
  // referenciales que ya arma applyGlobalDiscountAffectsBase (subtotalPRE-based,
  // no tocar — es lo probado para NC motivo 04). Si no afecta base, se arman
  // directo con el monto/base ya autoconsistentes del punto 6 (no usar
  // gl.allowances53 aquí: usa una base distinta y quedaría desalineado).
  const documentAllowances = globalAffectsBase
    ? gl.allowances53
    : (total_discount > 0 && options.discount_global_id
        ? [{
            chargeIndicator: false,
            id: '53',
            reasonCode: options.discount_global_id,
            amount: total_discount,
            multiplierFactorNumeric: discountChargeBase > 0 ? Number(((total_discount / discountChargeBase) * 100).toFixed(5)) : 0,
          }]
        : []);
  const documentCharges = globalAffectsBase
    ? gl.charges55
    : (total_charge > 0 && options.charge_global_id
        ? [{
            chargeIndicator: true,
            id: '55',
            reasonCode: options.charge_global_id,
            amount: total_charge,
            multiplierFactorNumeric: discountChargeBase > 0 ? Number(((total_charge / discountChargeBase) * 100).toFixed(5)) : 0,
          }]
        : []);

  return {
    items: distributedItems,
    totalsInit,
    totals,
    documentAllowances,
    documentCharges,
    meta: res.meta
  };
}

/**
 * Reparte el ajuste de un descuento/cargo global dentro de cada línea,
 * proporcional a su participación en la base de su categoría (gravada u
 * "otras": exonerada/inafecta/exportación). Necesario para que SUNAT acepte
 * el documento — ver el comentario en calculateTotalsWithGlobals.
 *
 * El IGV de línea se escala por el MISMO ratio que la base (no se recalcula
 * como base×igvRate): recalcularlo independiente diverge del IGV del
 * documento (gl.newTax, que sale de un camino de redondeo distinto — dividir
 * el total-con-IGV descontado entre 1+igvRate) y deja un céntimo de
 * descuadre entre línea y documento. Verificado enviando a SUNAT beta: ese
 * céntimo también se rechaza.
 *
 * Reconciliación: la suma de bases/impuestos repartidos puede quedar a 1
 * céntimo del objetivo por el redondeo de cada línea (2 decimales); el
 * residuo se ajusta en la ÚLTIMA línea de la categoría, mismo patrón
 * anti-penny que el resto del motor.
 */
function distributeGlobalAdjustmentToLines(items, {taxedRatio, otherRatio, targetTaxedBase, targetTaxedTax, targetOtherTotal}) {
  const taxedIdx = [];
  const otherIdx = [];

  const distributed = items.map((item, idx) => {
    if (item.category === 'free') return {...item};

    if (item.category === 'taxed') {
      if (taxedRatio === 1) return {...item};
      taxedIdx.push(idx);
      const newBase = Decimal.roundMoney(item.base * taxedRatio);
      const newTax = Decimal.roundMoney(item.tax * taxedRatio);
      const newTotal = Number((newBase + newTax).toFixed(2));
      // unit_price (con IGV, SUNAT catálogo 16 price_amount_01) Y unit_value
      // (sin IGV, price_amount_02) — faltaba este último: sin él,
      // cac:CreditNoteLine/cbc:LineExtensionAmount (que sale de total_value,
      // ligado a unit_value) no reconcilia contra el nuevo total_value de la
      // línea y SUNAT rechaza con 3271. Verificado enviando a SUNAT beta.
      const newUnitPrice = item.quantity > 0 ? Number((newTotal / item.quantity).toFixed(6)) : item.unit_price;
      const newUnitValue = item.quantity > 0 ? Number((newBase / item.quantity).toFixed(6)) : item.unit_value;
      return {...item, base: newBase, tax: newTax, subtotal: newBase, total: newTotal, unit_price: newUnitPrice, unit_value: newUnitValue};
    }

    // exonerated / unaffected / exportation: sin IGV, subtotal = total.
    if (otherRatio === 1) return {...item};
    otherIdx.push(idx);
    const newTotal = Decimal.roundMoney(item.total * otherRatio);
    const newUnitValue = item.quantity > 0 ? Number((newTotal / item.quantity).toFixed(6)) : item.unit_value;
    return {...item, base: newTotal, tax: 0, subtotal: newTotal, total: newTotal, unit_price: newUnitValue, unit_value: newUnitValue};
  });

  const reconcileField = (idxList, target, field) => {
    if (idxList.length === 0 || target == null) return;
    const sum = idxList.reduce((acc, i) => acc + distributed[i][field], 0);
    const delta = Number((target - sum).toFixed(2));
    if (delta === 0) return;
    const last = distributed[idxList[idxList.length - 1]];
    last[field] = Number((last[field] + delta).toFixed(2));
  };

  reconcileField(taxedIdx, targetTaxedBase, 'base');
  reconcileField(taxedIdx, targetTaxedTax, 'tax');
  taxedIdx.forEach((i) => {
    const line = distributed[i];
    line.subtotal = line.base;
    line.total = Number((line.base + line.tax).toFixed(2));
    if (line.quantity > 0) {
      line.unit_price = Number((line.total / line.quantity).toFixed(6));
      line.unit_value = Number((line.base / line.quantity).toFixed(6));
    }
  });

  reconcileField(otherIdx, targetOtherTotal, 'base');
  otherIdx.forEach((i) => {
    const line = distributed[i];
    line.subtotal = line.base;
    line.total = line.base;
    if (line.quantity > 0) {
      line.unit_price = Number((line.total / line.quantity).toFixed(6));
      line.unit_value = line.unit_price;
    }
  });

  return distributed;
}

/////////////////////////////////////////////
// Payload típico para enviar al backend
/////////////////////////////////////////////
export function buildBackendPayload(calcResult) {
  const totals = calcResult.totals ?? calcResult.totalsPre ?? null;
  const totalsInit = calcResult.totalsInit ?? null;
  const items = (calcResult.items || []).map(i => {
    const {_taxScaled, _totalScaled, _taxResidualScaled, ...clean} = i;
    return clean;
  });
  return {
    items,
    totalsInit,
    totals,
    document_allowances: calcResult.documentAllowances || [],
    document_charges: calcResult.documentCharges || [],
    meta: calcResult.meta || {}
  };
}
