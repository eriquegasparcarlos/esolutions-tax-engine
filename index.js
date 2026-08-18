/**
 * @esolutions/tax-engine
 *
 * API RECOMENDADA (v2): `calculateDocument` y `calculateNote` desde '@esolutions/tax-engine'.
 * Es la caja negra: se envían los parámetros y los ítems, se recibe todo calculado.
 *
 * El resto de exports son las piezas internas y los motores heredados. Siguen publicados
 * para no romper a quien ya los usaba, pero un consumidor nuevo solo necesita las dos
 * funciones de arriba.
 */

// ─── API v2 (la que hay que usar) ───────────────────────────────────────────
export { calculateDocument, calculateNote } from './src/api.js'
export { TaxEngineError, ValidationError, UnsupportedError } from './src/errors.js'
export {
  CATEGORY,
  CREDIT_NOTE_TYPES,
  DEBIT_NOTE_TYPES,
  DEFAULT_AFFECTATION_CATALOG,
  buildAffectationResolver,
  buildCatalogs,
} from './src/catalogs.js'

// ─── Adaptador al contrato de emisión ───────────────────────────────────────
export * from './src/adapter.js'

// ─── Piezas de bajo nivel y motores heredados ───────────────────────────────
export * from './src/tax-engine.js'
export * from './src/pos.js'
export * from './src/billing.js'
