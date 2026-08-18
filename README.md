# @esolutions/tax-engine

Motor de impuestos SUNAT (Perú). **Caja negra**: se envían los parámetros del comprobante
y sus ítems, y se recibe todo calculado. Funciones puras, sin estado, sin dependencias de
runtime y sin acoplamiento a ningún framework — corre igual en Vue, React o Node.

```jsonc
// package.json
"dependencies": {
  "@esolutions/tax-engine": "github:eriquegasparcarlos/esolutions-tax-engine#v2.0.0"
}
```

## Uso

```js
import { calculateDocument } from '@esolutions/tax-engine'

const r = calculateDocument({
  catalogs: { affectation_igv_types: filasDeTuCatalogo },
  document: { document_type_id: '01', currency_id: 'PEN', igv_rate: 0.18 },
  items: [
    { name: 'Consultoría', quantity: 3, unit_price: 50, unit_type_id: 'NIU', affectation_igv_type_id: '10' },
  ],
})

r.totals.total      // 150
r.totals.total_igv  // 22.88
r.lines[0].total_base_igv // 127.12
```

Dos funciones y nada más: **`calculateDocument`** para cualquier comprobante y
**`calculateNote`** para notas de crédito (07) y de débito (08).

## Qué cubre

- Precio unitario (con IGV) o **valor unitario** (sin IGV), definido por documento o por ítem
- Descuentos y cargos **por línea** y **globales**, afecten o no la base imponible
- Las cinco categorías del catálogo 07, **según la tabla que vos inyectás**
- **ICBPER** (impuesto a la bolsa plástica)
- **Detracción** (con mínimo y conversión a soles) y **retención**
- Ítems en **otra moneda** que el comprobante, con tipo de cambio
- **Notas de crédito y débito**, todos los tipos, incluidos los que van sin importes

No cubre **IVAP** (afectación 17) ni **ISC**. No los calcula mal ni los ignora: rechaza el
documento con un error explícito.

## Los catálogos los pone el consumidor

La clasificación del catálogo 07 **no está embebida**. Se inyecta con la forma de la tabla
real, para poder pasarla tal cual desde la base de datos:

```js
catalogs: {
  affectation_igv_types: [
    { id: '10', free: 0, exportation: 0, parent: '10', is_active: 1 },
    { id: '32', free: 1, exportation: 0, parent: '30', is_active: 1 },
    // …
  ],
  detraction_types: [{ id: '01', code: '001', percentage: 12, minimum_amount: 700 }],
  retention_types:  [{ id: '01', code: '01', percentage: 3 }],
}
```

La categoría sale de `free`, `exportation` y `parent` — nunca del número. Así podés
desactivar un código, agregar uno nuevo o corregir una clasificación sin esperar una
versión del paquete.

**Por qué importa:** cuando la tabla vivía adentro, el motor podía contradecir al catálogo
de la aplicación. Pasó de verdad — un linaje cobraba los códigos 32–36 (retiros, que son
transferencias gratuitas) porque los tenía como onerosos, mientras la tabla del producto
los marcaba `free = 1`.

Si no pasás catálogo se usa `DEFAULT_AFFECTATION_CATALOG`, útil para scripts y pruebas.

## Entrada

### `document`

| Campo | Req. | Qué es |
|---|---|---|
| `document_type_id` | sí | Catálogo 01: `01` factura, `03` boleta, `07` NC, `08` ND |
| `currency_id` | sí | Moneda del comprobante: `PEN`, `USD` |
| `igv_rate` | sí | **Fracción**: `0.18`, no `18` |
| `exchange_rate` | condicional | Obligatorio si algún ítem viene en otra moneda |
| `pricing_mode` | no | `'price'` (con IGV, por defecto) o `'value'` (sin IGV) |
| `icbper_rate` | no | Monto por bolsa, si no se define por ítem |
| `operation_type_id` | no | Catálogo 17; se refleja en la salida |

### `items[]`

| Campo | Req. | Qué es |
|---|---|---|
| `quantity` | sí | Mayor que cero |
| `unit_price` / `unit_value` | sí | Según `pricing_mode`; uno de los dos |
| `affectation_igv_type_id` | sí | Debe existir y estar activo **en tu catálogo** |
| `name`, `unit_type_id`, `item_id` | no | Se devuelven tal cual |
| `pricing_mode` | no | Sobreescribe al del documento, por ítem |
| `currency_id` | no | Si difiere del documento, se convierte |
| `has_icbper`, `icbper_rate`, `icbper_quantity` | no | Bolsas: cantidad propia si difiere de la del ítem |
| `discounts[]`, `charges[]` | no | `{type:'percent'\|'amount', value, affects_base?, reason_code?}` |

### Descuentos y cargos

Misma forma en línea y globales (`global_discounts`, `global_charges`). **`type` es
obligatorio** — en la v1 su ausencia descartaba el descuento en silencio y el comprobante
salía por el total completo.

`affects_base` (por defecto `true`) decide si el ajuste baja también la base imponible y
con ella el IGV. Ponerlo en `false` es el modelo del catálogo 53 código 02: base e IGV
quedan intactos y solo baja el importe a pagar.

> Para la **nota de crédito por descuento global** el ajuste tiene que repartirse dentro de
> las líneas (`affects_base: true`). Si no, SUNAT rechaza con el error **3277**.

### `detraction` y `retention`

```js
detraction: { type_id: '01', percentage: 12, payment_method_id: '001', account: '00-123-456' }
retention:  { type_id: '01', percentage: 3 }
```

El porcentaje sale del catálogo si no lo enviás. Ninguna de las dos modifica los importes
del comprobante: cambian **cuánto se transfiere**.

### `note` (solo 07 y 08)

```js
note: {
  type_id: '01',                    // catálogo 09 (crédito) o 10 (débito)
  description: 'Anulación de la operación',
  affected_document_type_id: '01',
  affected_series: 'F001',
  affected_number: 123,
}
```

## Salida

### `totals`

| Campo | Qué es |
|---|---|
| `total_taxed` | Base de las operaciones **gravadas** (sin IGV) |
| `total_exonerated` | Total de las operaciones **exoneradas** |
| `total_unaffected` | Total de las operaciones **inafectas** |
| `total_exportation` | Total de **exportación** |
| `total_free` | Valor referencial de las **gratuitas** (no se cobra) |
| `total_value` | **Valor de venta**: suma de las bases imponibles, sin IGV |
| `total_base_igv` | Base sobre la que se aplicó el IGV |
| `total_igv` | IGV del comprobante |
| `total_igv_free` | IGV **referencial** de las gratuitas gravadas (11–16): se informa, no se cobra |
| `total_icbper` | Impuesto a las bolsas plásticas |
| `total_taxes` | Suma de tributos: `total_igv + total_icbper` |
| `total_discount` | Descuentos globales aplicados |
| `total_charge` | Cargos globales aplicados |
| `total` | **Importe total del comprobante** (lo que va en el XML) |
| `total_pay` | **Importe a transferir**: `total − detracción − retención` |

> `total` es lo que SUNAT ve. `total_pay` es lo que el cliente efectivamente paga al
> proveedor. Son distintos en cuanto hay detracción o retención.

### `lines[]`

| Campo | Qué es |
|---|---|
| `index` | Posición, en el mismo orden que entraron |
| `item_id`, `name`, `unit_type_id`, `quantity` | Identidad de la línea |
| `unit_value` | Valor unitario **sin** IGV (6 decimales) |
| `unit_price` | Precio unitario **con** IGV |
| `affectation_igv_type_id` | El código con el que se calculó |
| `affectation_category` | `taxed` · `exonerated` · `unaffected` · `exportation` · `free` |
| `affectation_name` | Nombre según tu catálogo |
| `is_free` | `true` si es transferencia gratuita |
| `total_base_igv` | Base imponible de la línea (0 si no es gravada) |
| `percentage_igv` | Porcentaje aplicado (0 si no es gravada) |
| `total_igv` | IGV de la línea |
| `total_igv_free` | IGV referencial si es gratuita gravada |
| `total_icbper` | ICBPER de la línea |
| `total_value` | Valor de venta de la línea |
| `total_discount` / `total_charge` | Ajustes aplicados en la línea |
| `total_taxes` | Tributos de la línea |
| `total` | Total de la línea |
| `discounts[]` / `charges[]` | Detalle UBL de los ajustes |
| `source` | Lo que **vos** mandaste: moneda, modo y el importe original |

> `source` existe para poder repintar el formulario y recalcular en otra moneda sin haber
> perdido el dato de origen.

### `detraction` / `retention` (`null` si no aplican)

| Campo | Qué es |
|---|---|
| `type_id`, `code` | Tipo aplicado |
| `percentage` | Porcentaje usado (del catálogo o el que enviaste) |
| `base` | Importe sobre el que se calculó |
| `amount` | Monto resultante |
| `applies` *(detracción)* | `false` si no llega al mínimo |
| `minimum_amount` *(detracción)* | Mínimo evaluado (S/ 700 por defecto) |
| `amount_currency_id` *(detracción)* | Siempre `PEN`: el depósito es en soles |
| `reason` *(detracción)* | Por qué no aplicó, cuando `applies` es `false` |

### `note`, `global_discounts`, `global_charges`, `meta`

`note` repite el tipo, su nombre, el comprobante afectado y `zero_amounts`.
`meta` refleja los parámetros con los que se calculó (`currency_id`, `exchange_rate`,
`igv_rate`, `pricing_mode`, `engine_version`).

## Moneda y tipo de cambio: reversibles

El motor deriva **siempre** de los valores originales del ítem, nunca de un resultado
anterior, y no muta la entrada. Entonces cambiar la moneda o corregir el tipo de cambio es
simplemente volver a llamar la función: los importes iniciales se recuperan exactos.

```js
const a = calculateDocument(params(3.75))
calculateDocument(params(3.90))
const b = calculateDocument(params(3.75))
// a.totals === b.totals
```

Si el motor reescribiera los ítems en cada pasada, ir y volver acumularía error de
redondeo. Hay un test que fija esto.

## Errores

La entrada se valida de forma **estricta** y el error se lanza: nada se calcula a medias.
En este dominio un cálculo silenciosamente incompleto termina en un comprobante firmado
con importes equivocados.

```js
try {
  calculateDocument(entrada)
} catch (e) {
  if (e instanceof ValidationError) {
    e.errors   // [{ path: 'items[0].quantity', code: 'invalid', message: '…' }]
    e.byPath() // { 'items[0].quantity': ['…'] }  ← cómodo para un formulario
  }
}
```

Se devuelven **todos** los problemas, no solo el primero.

## Validado contra el emisor real

La cadena cruza dos lenguajes: el motor calcula en JS y quien dictamina si un comprobante
es válido es `esolutions/xml` (PHP), que arma el UBL y lo valida contra el XSD y las reglas
de SUNAT. Un test de cada lado no ve el tramo del medio — que es donde vive el 3277.

Por eso `tests/fixtures/api/` se **commitea**: son escenarios generados por el motor real,
que el lado PHP lee y emite sin necesitar node.

```bash
pnpm test        # 141 tests
pnpm fixtures    # regenerar tras cambiar el motor
```

En intipos131 el consumidor es `tests/Feature/TaxEngineEmissionTest.php`, que por cada
fixture verifica que emita un XML válido, que los importes del XML sean los calculados, y
que las líneas sumen el total de la cabecera.

## Módulos

| Módulo | Estado |
|---|---|
| `src/api.js` | **La API pública.** `calculateDocument` / `calculateNote` |
| `src/catalogs.js` | Catálogos inyectables y clasificación |
| `src/validate.js` | Validación estricta |
| `src/billing.js` | El cálculo probado contra SUNAT, ahora parametrizado |
| `src/adapter.js` | Traducción a los campos del comprobante |
| `src/pos.js`, `src/tax-engine.js` | Linaje heredado (v1). Legacy |

Sobre el linaje heredado: `tests/differential.test.js` corre los mismos escenarios por
ambos motores y verifica que coincidan al centavo. Coinciden en todo el camino principal;
las diferencias conocidas están enumeradas ahí.

## Defectos conocidos

Fijados con tests marcados `[bug conocido]`, para que corregirlos sea deliberado:

1. `pos.js` (legacy) cobra las transferencias gratuitas 32–36 y deja el documento
   descuadrado en 17 y 32–36. **La API v2 no tiene este problema**: usa tu catálogo.
2. El **ISC** no se calcula en ningún linaje.
3. **IVAP** (17) no está implementado — la v2 lo rechaza en vez de emitirlo mal.

## Licencia

MIT © Carlos Erique Gaspar
