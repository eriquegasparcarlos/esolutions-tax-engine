/**
 * Errores del motor.
 *
 * La entrada se valida de forma ESTRICTA y el error se lanza, no se devuelve un resultado
 * a medias. La razón es concreta: en este dominio un cálculo silenciosamente incompleto
 * termina en un comprobante emitido y firmado con importes equivocados. Ya pasó dos veces
 * en las versiones anteriores —el IGV de línea en cero y el descuento global descartado
 * por falta de un campo— y en ambos casos el usuario vio en pantalla algo distinto de lo
 * que se mandó a SUNAT.
 *
 * Mejor romper en el momento de calcular, con el campo señalado.
 */

/**
 * @typedef {Object} Issue
 * @property {string} path    ruta al campo, ej. 'items[2].quantity'
 * @property {string} code    código estable, apto para traducir o mapear a un mensaje propio
 * @property {string} message descripción en español
 */

export class TaxEngineError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TaxEngineError'
  }
}

/** Entrada inválida. `errors` trae TODOS los problemas, no solo el primero. */
export class ValidationError extends TaxEngineError {
  /** @param {Issue[]} errors */
  constructor(errors) {
    const lista = errors.map((e) => `${e.path}: ${e.message}`).join(' | ')
    super(`Entrada inválida para el motor de impuestos — ${lista}`)
    this.name = 'ValidationError'
    this.errors = errors
  }

  /** Agrupado por campo, cómodo para pintar errores en un formulario. */
  byPath() {
    return this.errors.reduce((acc, e) => {
      ;(acc[e.path] ??= []).push(e.message)
      return acc
    }, {})
  }
}

/** Caso fiscal reconocido pero que el motor todavía no calcula (ej. IVAP). */
export class UnsupportedError extends TaxEngineError {
  constructor(message, code) {
    super(message)
    this.name = 'UnsupportedError'
    this.code = code
  }
}
