# Resultado de la validación · 0.2

Validado en el entorno cloud Linux el 25 de octubre de 2026. Los resultados describen esta ejecución y sus artefactos; no una instalación ya publicada ni los equipos físicos del usuario.

| Comprobación | Resultado |
|---|---|
| `npm test` | **73 aprobadas**, 0 fallidas, 0 omitidas. |
| `npm run typecheck` | Aprobado. |
| `npm run test:e2e -- --output=/tmp/inhouse-v02-final` | **22 aprobadas**, 0 fallidas, 0 omitidas. |
| Verificación del manifiesto de publicación | **4 aprobadas**, 0 fallidas. |
| Compilación web de producción | Aprobada. |
| Instalación limpia con `npm ci` y compilación en un directorio temporal | Aprobadas; mismos activos de producción. |
| `npm run build:windows` | Portable Windows generado y descarga web preparada. |
| Comprobación del payload Windows | PE x64, manifiesto propio, web compilada, señalización y auxiliar nativo fuera de ASAR presentes. |
| Paquete web independiente | Instalación congelada de dependencias de producción y peticiones funcionales a web, activos, configuración y health aprobadas. |
| Publicación de configuración/nueva máquina | No ejecutada; instalación y arranque guardados en borrador para revisión. |

## Alcance de las pruebas

Las pruebas de Node cubren señalización, aprobación, aislamiento, rechazo, expiración, origen, clave de servicio, TURN HMAC, identidad firmada, estáticos, entrada limitada, coordenadas, contadores WebRTC y confianza.

Las 22 de navegador incluyen cuenta Google y cambio de cuenta, descargas públicas, rechazo de enlaces inseguros, broker Windows cifrado, interfaz, regresiones de seguridad y transmisión e integración. Comprueban vídeo realmente codificado/decodificado, avance de fotogramas, audio sintético transportado, estadísticas reales, canales de entrada, bitrate efectivo, vinculación, autenticación mutua, rechazo de credenciales alteradas, denegación de control y recuperación tras reiniciar realmente el servidor de señalización. También ejercitan la UI sobre vídeo real, aprobación, menú flotante, atajos, pantalla completa, ajustes, arrastre y desconexión.

Chromium tiene una política gestionada que impide UDP no enviado mediante proxy. Se ha respetado: la validación utiliza **coturn TCP real en loopback**. No se han cambiado políticas del navegador ni sustituido WebRTC por mocks. La instalación de coturn ha conservado la verificación de la firma Debian, el índice firmado y SHA256 de cada paquete.

La adquisición de pantalla se sustituye por un canvas animado y un origen de audio sintético. El proveedor Google se sustituye por respuestas de prueba. El límite nativo Windows registra las llamadas que llegarían a Win32. Esas sustituciones permiten probar el transporte real; **no validan captura física, audio loopback, inyección Win32, mandos ni compatibilidad con juegos**.

## Artefactos

- `artifacts/Inhouse-Link-Windows.exe`: portable Windows; incluye el runtime. Sin firma de código propia.
- `artifacts/Inhouse-Link-Web.zip`: cliente de producción y servicio Node, sin secretos ni ejecutable Windows incrustado.
- `artifacts/Inhouse-Link-Source.zip`: fuentes propias y configuración, sin dependencias, referencias descargadas, secretos ni binarios generados.
- Ficheros SHA256 junto a cada distribución.
- Capturas de la interfaz y del menú durante la transmisión sintética en `artifacts/screenshots/`.

El `.exe` se ha generado desde Linux y se ha inspeccionado su contenido. El workflow añade una comprobación del auxiliar C# en Windows real, cuyo resultado pertenece a esa ejecución de Actions. Aún debe ejecutarse en Windows y comprobarse la lista de [desktop/README.md](../desktop/README.md).

La publicación de web, descargas y cliente en GitHub se realiza mediante el workflow documentado; no crea un backend Node ni TURN públicos. El consentimiento con una cuenta Google real sigue requiriendo comprobación en el navegador del usuario. No se ha medido el enlace Murcia–Valencia ni latencia de entrada a pantalla frente a Parsec u otras alternativas. HDR, 4:4:4, mandos, monitor virtual y paridad completa del menú Parsec siguen fuera de esta versión. [comparison.md](comparison.md) distingue las funciones implementadas y pendientes.
