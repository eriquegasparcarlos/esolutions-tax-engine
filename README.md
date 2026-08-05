# @esolutions/tax-engine

Motor de impuestos SUNAT (Perú). Funciones **puras** — sin estado reactivo ni
dependencias de framework — para el cálculo de IGV/ISC/ICBPER, redondeo fiscal,
tipos de afectación y descuento global. Fuente única compartida entre el POS,
hoteles y cualquier otro proyecto ESolutions.

## Instalación

Consumido como paquete VCS desde GitHub (igual que el resto de `@esolutions/*`):

```jsonc
// package.json
"dependencies": {
  "@esolutions/tax-engine": "github:eriquegasparcarlos/esolutions-tax-engine#v1.0.0"
}
```

## Uso

```js
import {
  round, r2, r4,
  isGravado, isGratuito, isGravadoGratuito,
  sumBy, getAmountFromInputDiscount,
  calculateDiscountGlobal,
} from '@esolutions/tax-engine'

r2(10.005)          // 10.01
isGravado('10')     // true  (gravado 10–17)
isGratuito('11')    // true  (gratuito cat. 07: no se cobra)

// Descuento global sobre totales ya calculados:
const totales = calculateDiscountGlobal(form, true, '02', 10) // 10% de descuento
```

## API

| Función | Descripción |
|---|---|
| `round(value, decimals=2)` | Redondeo a N decimales. |
| `r2(n)` / `r4(n)` | Redondeo fiscal a 2 / 4 decimales. |
| `isGravado(igvType)` | `true` para tipos 10–17 (aplica IGV). |
| `isGratuito(igvType)` | Operación gratuita (11–16, 21, 31, 37): no se cobra. |
| `isGravadoGratuito(igvType)` | Gratuito con IGV referencial (11–16). |
| `sumBy(arr, fn)` | Suma `fn(item)` sobre el arreglo. |
| `getAmountFromInputDiscount(discount)` | Monto o porcentaje según `use_input_amount`. |
| `calculateDiscountGlobal(form, enabled, type, amount)` | Aplica descuento global a los totales (`'02'`=%, otro=monto). |

## Licencia

MIT © Carlos Erique Gaspar
