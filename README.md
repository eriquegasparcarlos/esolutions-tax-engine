# @esolutions/tax-engine

Motor de impuestos SUNAT (Perú). Funciones **puras** — sin estado reactivo ni
dependencias de framework — para el cálculo de IGV/ICBPER, redondeo fiscal, tipos de
afectación y descuento global.

## Estado: dos linajes conviviendo

El paquete arrastra **dos implementaciones de distinto origen**. Conviene saberlo antes
de elegir cuál importar:

| Módulo | Origen | Estado |
|---|---|---|
| `src/billing.js` | intipos13 (`peru_billing_totals_all`) | **Recomendado.** Es el que emite comprobantes aceptados por SUNAT hoy. |
| `src/pos.js` | intipos v1 (`functions_2.js`) | Legacy. Se conserva para POS/hoteles mientras migran. |
| `src/tax-engine.js` | helpers compartidos | Redondeo, clasificación cat.07, descuento global. |
| `src/adapter.js` | traducción al comprobante | Motor → campos del dominio SUNAT. |

**Coinciden numéricamente en el camino principal.** El guard en
`tests/differential.test.js` corre los mismos 10 escenarios por ambos motores y verifica
que den lo mismo al centavo, incluida la factura real B002-5 (3 × 50 → 127.12 + 22.88).

Diferencias: `billing.js` trabaja en **enteros escalados** (`Decimal`, mathScale 6) en vez
de flotantes con `toFixed`, y agrega **proyección de moneda** y `buildBackendPayload`, que
`pos.js` no tiene.

## Instalación

```jsonc
// package.json
"dependencies": {
  "@esolutions/tax-engine": "github:eriquegasparcarlos/esolutions-tax-engine#v1.3.1"
}
```

## Uso

```js
import {
  normalizeItemPricing, projectItemToDocCurrency,
  calculateTotalsWithGlobals, buildBackendPayload,
} from '@esolutions/tax-engine/billing'

// El formulario manda el precio CON IGV incluido:
const items = [
  normalizeItemPricing(
    { unit_price: 50, quantity: 3, affectation_igv_type_id: '10', pricing_mode: 'price' },
    0.18,
  ),
]

const calc = calculateTotalsWithGlobals(items, { igvRate: 0.18 })
calc.totals // { subtotal: 127.12, tax: 22.88, total: 150 }

const payload = buildBackendPayload(calc)
```

Ítem en otra moneda que el documento:

```js
const enPen = projectItemToDocCurrency(item, 'PEN', 3.75, 0.18) // USD 100 → PEN 375
```

Descuento global — **los tres campos son obligatorios**, ver defectos abajo:

```js
calculateTotalsWithGlobals(items, {
  igvRate: 0.18,
  discount_global_id: '02',
  discount_global_type: '02',   // '02' = porcentaje
  discount_global_amount: 10,
  globalAffectsBase: true,      // false = solo baja el total a pagar (cat.53 cód. 02)
})
```

`globalAffectsBase: true` reparte el descuento **dentro de cada línea**. Es obligatorio
para la nota de crédito motivo 04: sin eso SUNAT rechaza con el error 3277 (*la sumatoria
del total valor de venta de línea no corresponde al total*).

## Adaptador motor → comprobante

El motor nombra los importes en términos de cálculo (`subtotal`, `base`, `tax`) y el
comprobante los guarda con los nombres del dominio SUNAT (`total_value`,
`total_base_igv`, `total_igv`). Esa traducción **es lógica fiscal**, no plomería: con el
mapeo incompleto el documento salía con el total correcto pero el IGV de cada **línea** en
cero — y como el XML se arma línea por línea, SUNAT recibía los tributos descuadrados.

```js
import { toApiLine, toApiTotals, toApiDiscounts } from '@esolutions/tax-engine/adapter'

const calc = calculateTotalsWithGlobals(items, { igvRate: 0.18 })

const lineas = calc.items.map(l => ({
  ...toApiLine(l, { igvRate: 0.18 }),   // solo importes
  ...miMetadata(l),                      // nombre, imagen, lotes: de cada app
}))
Object.assign(form, toApiTotals(calc))
form.discounts = toApiDiscounts(calc, { discountGlobalType, discountGlobalAmount })
```

El adaptador devuelve **solo campos de importes**. La metadata de presentación (nombre,
imagen, lotes, listas de precio) es de cada aplicación y se le hace spread encima.

## Validación contra el emisor real

La cadena a probar cruza dos lenguajes: el motor calcula en JS, y quien dictamina si un
comprobante es válido es `esolutions/xml` (PHP), que arma el UBL y lo valida contra el XSD
y las reglas de SUNAT. Un test de cada lado por separado no ve el tramo del medio — que es
donde vive el error **3277** (*la sumatoria del total valor de venta de línea no
corresponde al total*).

Por eso `tests/fixtures/api/` se **commitea**: son 8 escenarios generados por el motor real
a través del adaptador, y el lado PHP los lee y los emite sin necesitar node.

```bash
pnpm fixtures   # regenerar tras cambiar el motor
```

Un test verifica que los fixtures sigan sincronizados: si alguien cambia el cálculo y no
regenera, salta ahí en vez de aparecer como un rechazo de SUNAT.

En intipos131 el consumidor es `tests/Feature/TaxEngineEmissionTest.php`, que por cada
fixture verifica tres cosas: que emita un XML que pase XSD + reglas, que los importes del
XML sean los que calculó el motor, y que la suma de las líneas dé el total de la cabecera.

## Defectos conocidos

Están **fijados con tests** (marcados `[bug conocido]`) para que el arreglo sea un cambio
deliberado y no una regresión silenciosa.

1. **`pos.js` cobra las transferencias gratuitas 32–36.** Los códigos 32–36 son
   *Inafecto – Retiro por {muestras médicas, convenio colectivo, premio, publicidad}*:
   son gratuitos, y así los marca el catálogo del producto
   (`cat_affectation_igv_types.free = 1`). `billing.js` los clasifica bien.
2. **`pos.js` deja el documento descuadrado en 17 y 32–36:** acumula el importe en
   `total_value` pero deja `total` en 0, o sea el valor de venta no corresponde al total.
3. **El ISC nunca se calcula.** Está declarado en la fila (`percentage_isc`,
   `total_base_isc`, `total_isc`) pero `totalIsc` nace en 0 y jamás se reasigna. Ningún
   linaje lo implementa.
4. **El descuento global se descarta en silencio si falta `discount_global_type`.** El
   guard de entrada solo exige `id` y `amount`, pero `pushGlobal()` exige también `type`
   y, si falta, retorna sin aplicar nada. El usuario ve el descuento y el comprobante
   sale por el total completo.
5. **IVAP (código 17) no está implementado** en ninguno de los dos. Es una operación
   onerosa con tasa propia. En el producto el código está `is_active = 0`.

## Hacia la v2

La clasificación del catálogo 07 está **hardcodeada** en el paquete, pero la fuente de
verdad real es el catálogo del tenant (`cat_affectation_igv_types`, con su columna
`free`). Si SUNAT cambia un código hay que tocar el paquete. La v2 debería permitir
inyectar esa tabla, además de unificar los dos linajes en uno y arreglar los defectos
de arriba.

## Tests

```bash
pnpm install
pnpm test
```

93 tests. Los de `billing.js` son de **caracterización**: fijan los números que hoy se
mandan a SUNAT, así que si uno se rompe es porque cambió la plata.

## Licencia

MIT © Carlos Erique Gaspar
