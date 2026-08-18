/**
 * Catálogos SUNAT inyectados por el consumidor.
 *
 * POR QUÉ INYECTADOS Y NO EMBEBIDOS
 * Hasta la v1 el motor traía la clasificación del catálogo 07 escrita a mano. Eso tiene
 * dos problemas: si SUNAT da de baja o agrega un código hay que publicar el paquete, y
 * —peor— el motor puede contradecir al catálogo que la aplicación realmente usa. Pasó:
 * un linaje cobraba los códigos 32–36 (retiros, o sea transferencias gratuitas) porque
 * los tenía como onerosos, mientras la tabla del producto los marcaba `free = 1`.
 *
 * Acá la tabla del consumidor es la autoridad. El motor solo la normaliza y la valida.
 *
 * FORMA ESPERADA
 * La de la tabla real (`cat_affectation_igv_types`), para poder pasarla tal cual:
 *
 *   [{ id: '10', free: 0, exportation: 0, parent: '10', code: '1000', is_active: 1 }, …]
 *
 * `free` y `exportation` aceptan 0/1, true/false o '0'/'1' (los ORM devuelven cualquiera
 * de las tres).
 */

import { ValidationError } from './errors.js'

/** Categorías con las que el motor razona. Derivadas del catálogo, no hardcodeadas. */
export const CATEGORY = {
  TAXED: 'taxed', // gravado oneroso: paga IGV
  EXONERATED: 'exonerated', // exonerado oneroso
  UNAFFECTED: 'unaffected', // inafecto oneroso
  EXPORTATION: 'exportation', // exportación
  FREE: 'free', // transferencia gratuita: no se cobra
}

const bool = (v) => v === true || v === 1 || v === '1' || v === 'true'

/**
 * Catálogo 07 mínimo, por si el consumidor no tiene tabla propia (scripts, pruebas).
 * Es el vigente al 2026-08 y coincide con `cat_affectation_igv_types` de intipos131.
 *
 * OJO con el 17 (Gravado – IVAP): SUNAT lo define como operación ONEROSA con tasa propia
 * (arroz pilado). El motor no implementa IVAP, así que acá va marcado free = 0 —es lo
 * correcto— y `calculateDocument` rechaza el documento si aparece, en vez de emitirlo con
 * la tasa equivocada o, peor, sin cobrarlo.
 */
export const DEFAULT_AFFECTATION_CATALOG = [
  { id: '10', free: 0, exportation: 0, parent: '10', name: 'Gravado - Operación onerosa' },
  { id: '11', free: 1, exportation: 0, parent: '10', name: 'Gravado - Retiro por premio' },
  { id: '12', free: 1, exportation: 0, parent: '10', name: 'Gravado - Retiro por donación' },
  { id: '13', free: 1, exportation: 0, parent: '10', name: 'Gravado - Retiro' },
  { id: '14', free: 1, exportation: 0, parent: '10', name: 'Gravado - Retiro por publicidad' },
  { id: '15', free: 1, exportation: 0, parent: '10', name: 'Gravado - Bonificaciones' },
  { id: '16', free: 1, exportation: 0, parent: '10', name: 'Gravado - Retiro por entrega a trabajadores' },
  { id: '17', free: 0, exportation: 0, parent: '10', name: 'Gravado - IVAP' },
  { id: '20', free: 0, exportation: 0, parent: '20', name: 'Exonerado - Operación onerosa' },
  { id: '21', free: 1, exportation: 0, parent: '20', name: 'Exonerado - Transferencia gratuita' },
  { id: '30', free: 0, exportation: 0, parent: '30', name: 'Inafecto - Operación onerosa' },
  { id: '31', free: 1, exportation: 0, parent: '30', name: 'Inafecto - Retiro por bonificación' },
  { id: '32', free: 1, exportation: 0, parent: '30', name: 'Inafecto - Retiro' },
  { id: '33', free: 1, exportation: 0, parent: '30', name: 'Inafecto - Retiro por muestras médicas' },
  { id: '34', free: 1, exportation: 0, parent: '30', name: 'Inafecto - Retiro por convenio colectivo' },
  { id: '35', free: 1, exportation: 0, parent: '30', name: 'Inafecto - Retiro por premio' },
  { id: '36', free: 1, exportation: 0, parent: '30', name: 'Inafecto - Retiro por publicidad' },
  { id: '37', free: 1, exportation: 0, parent: '30', name: 'Inafecto - Transferencia gratuita' },
  { id: '40', free: 0, exportation: 1, parent: '40', name: 'Exportación de bienes o servicios' },
]

/** Códigos que el motor sabe calcular. El 17 (IVAP) está fuera a propósito. */
const UNSUPPORTED = new Set(['17'])

/**
 * Normaliza el catálogo 07 y devuelve un clasificador.
 *
 * La categoría NO se deduce del número: sale de `free`, `exportation` y `parent` de la
 * fila. Así el consumidor puede desactivar un código, agregar uno nuevo o corregir una
 * clasificación sin tocar el paquete.
 */
export function buildAffectationResolver(rows = DEFAULT_AFFECTATION_CATALOG) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ValidationError([
      {
        path: 'catalogs.affectation_igv_types',
        code: 'catalog_empty',
        message: 'El catálogo de afectaciones IGV es obligatorio y no puede venir vacío.',
      },
    ])
  }

  const byId = new Map()

  for (const [i, row] of rows.entries()) {
    if (row?.id == null || String(row.id) === '') {
      throw new ValidationError([
        {
          path: `catalogs.affectation_igv_types[${i}].id`,
          code: 'catalog_row_invalid',
          message: 'Cada fila del catálogo de afectaciones necesita un `id`.',
        },
      ])
    }

    const id = String(row.id)
    const isFree = bool(row.free)
    const isExportation = bool(row.exportation)
    const parent = row.parent != null && String(row.parent) !== '' ? String(row.parent) : id

    let category
    if (isFree) {
      category = CATEGORY.FREE
    } else if (isExportation || parent === '40') {
      category = CATEGORY.EXPORTATION
    } else if (parent === '10') {
      category = CATEGORY.TAXED
    } else if (parent === '20') {
      category = CATEGORY.EXONERATED
    } else {
      category = CATEGORY.UNAFFECTED
    }

    byId.set(id, {
      id,
      category,
      name: row.name ?? '',
      // Gratuito cuyo padre es gravado (11–16): no se cobra, pero SUNAT pide informar
      // el IGV que habría correspondido.
      isFreeTaxed: isFree && parent === '10',
      isActive: row.is_active === undefined ? true : bool(row.is_active),
      supported: !UNSUPPORTED.has(id),
    })
  }

  /*
  | La forma de este objeto es la que consume el motor de cálculo (`options.affectation`),
  | así que los nombres coinciden con los que él espera: category / isTaxed / isFreeTaxed.
  */
  return {
    /** @returns {{id, category, isFreeTaxed, isActive, supported, name}|null} */
    get: (code) => byId.get(String(code)) ?? null,
    has: (code) => byId.has(String(code)),
    category: (code) => byId.get(String(code))?.category ?? CATEGORY.UNAFFECTED,
    isTaxed: (code) => byId.get(String(code))?.category === CATEGORY.TAXED,
    isFree: (code) => byId.get(String(code))?.category === CATEGORY.FREE,
    isFreeTaxed: (code) => byId.get(String(code))?.isFreeTaxed === true,
    codes: () => [...byId.keys()],
  }
}

/**
 * Catálogo de tipos de detracción. Trae el porcentaje y el monto mínimo, que son datos
 * del catálogo y no del cálculo — por eso los pide inyectados en vez de traerlos fijos:
 * SUNAT los cambia por resolución.
 *
 * Forma: [{ id, code, percentage, minimum_amount }]
 * `minimum_amount` opcional; por defecto S/ 700 (el general vigente).
 */
export function buildDetractionResolver(rows = []) {
  const byId = new Map()

  for (const row of rows) {
    if (row?.id == null) continue
    byId.set(String(row.id), {
      id: String(row.id),
      code: row.code != null ? String(row.code) : String(row.id),
      percentage: Number(row.percentage ?? 0),
      minimumAmount: row.minimum_amount != null ? Number(row.minimum_amount) : 700,
    })
  }

  return {
    get: (id) => byId.get(String(id)) ?? null,
    has: (id) => byId.has(String(id)),
    isEmpty: () => byId.size === 0,
  }
}

/**
 * Catálogo de tipos de retención. Forma: [{ id, code, percentage }].
 */
export function buildRetentionResolver(rows = []) {
  const byId = new Map()

  for (const row of rows) {
    if (row?.id == null) continue
    byId.set(String(row.id), {
      id: String(row.id),
      code: row.code != null ? String(row.code) : String(row.id),
      percentage: Number(row.percentage ?? 0),
    })
  }

  return {
    get: (id) => byId.get(String(id)) ?? null,
    has: (id) => byId.has(String(id)),
    isEmpty: () => byId.size === 0,
  }
}

/**
 * Tipos de nota de crédito (catálogo 09) y de débito (catálogo 10).
 *
 * Se listan porque hay reglas de cálculo atadas al motivo: la NC 13 ("ajustes de
 * operaciones de exportación") y las de ajuste de monto no llevan importes, mientras que
 * la NC 01 (anulación) refleja el comprobante completo.
 */
export const CREDIT_NOTE_TYPES = {
  '01': { name: 'Anulación de la operación', zeroAmounts: false },
  '02': { name: 'Anulación por error en el RUC', zeroAmounts: false },
  '03': { name: 'Corrección por error en la descripción', zeroAmounts: true },
  '04': { name: 'Descuento global', zeroAmounts: false },
  '05': { name: 'Descuento por ítem', zeroAmounts: false },
  '06': { name: 'Devolución total', zeroAmounts: false },
  '07': { name: 'Devolución por ítem', zeroAmounts: false },
  '08': { name: 'Bonificación', zeroAmounts: false },
  '09': { name: 'Disminución en el valor', zeroAmounts: false },
  '10': { name: 'Otros conceptos', zeroAmounts: false },
  '11': { name: 'Ajustes de operaciones de exportación', zeroAmounts: false },
  '12': { name: 'Ajustes afectos al IVAP', zeroAmounts: false },
  '13': { name: 'Ajustes - montos y/o fechas de pago', zeroAmounts: true },
}

export const DEBIT_NOTE_TYPES = {
  '01': { name: 'Intereses por mora' },
  '02': { name: 'Aumento en el valor' },
  '03': { name: 'Penalidades / otros conceptos' },
  '11': { name: 'Ajustes de operaciones de exportación' },
  '12': { name: 'Ajustes afectos al IVAP' },
}

/**
 * Arma de una sola vez todos los resolvers a partir del bloque `catalogs` de la entrada.
 */
export function buildCatalogs(catalogs = {}) {
  return {
    affectation: buildAffectationResolver(catalogs.affectation_igv_types),
    detraction: buildDetractionResolver(catalogs.detraction_types),
    retention: buildRetentionResolver(catalogs.retention_types),
  }
}
