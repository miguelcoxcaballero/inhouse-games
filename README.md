# inhouse link

Streaming remoto propio para un PC Windows y un cliente web o Windows. El PC ejecuta los juegos; el cliente recibe vídeo y audio y devuelve teclado y ratón por WebRTC. Versión 0.2: web de descargas, cliente y cuenta Google con el sistema compartido de Inhouse Notes y Read. Su rendimiento frente a las alternativas debe medirse en los equipos reales.

Identidad contrastada con los proyectos de Inhouse: casa, nombres en minúsculas, Comfortaa + DM Sans, naranja `#E07A3C`, crema y superficies oscuras. La lógica es original; no se utiliza Parsec, Sunshine, Moonlight, Apollo ni RustDesk como motor.

## Funciones

- Web pública de producto y descargas; cliente en `#/client`, descargas en `#/downloads`.
- Google Identity Services, mismo cliente OAuth y flujo de Inhouse Read. Perfil obtenido de Google, validación del token en el servidor y sesiones propias de 30 días revocables. No necesita Firebase, Supabase ni un secreto OAuth en el cliente.
- Login Windows en el navegador externo, con transferencia cifrada de un solo uso a la aplicación. Los equipos vinculados se guardan por cuenta.
- Cliente web y aplicación Windows con modos anfitrión y cliente.
- Captura consentida de pantalla y audio loopback de Windows cuando está disponible.
- Medios cifrados por WebRTC, canal fiable para teclado/botones y canal de baja espera para movimientos del ratón.
- Aprobación por sesión o vinculación explícita para futuras conexiones sin nueva aprobación mientras el PC siga compartiendo. Identidad P-256, autenticación HMAC de confianza y revocación.
- Control Win32 propio: teclado, ratón absoluto/relativo, botones y rueda. No ejecuta comandos arbitrarios del cliente.
- Botón Inhouse flotante y arrastrable, ajustes en directo, pantalla completa, captura del ratón y estadísticas reales.
- Resolución solicitada, 30/60/120 FPS, bitrate, H.264/VP9/AV1 según capacidades, audio y adaptación al enlace.
- Exportación de diagnóstico sin claves ni contenido de pantalla. `node scripts/benchmark.mjs captura.json` calcula mediana y percentil95.
- Señalización autoalojable, STUN/TURN configurable y clave de servicio para proteger el acceso al relay.

Los objetivos de calidad se negocian: no garantizan esa resolución/FPS ni aceleración GPU en cualquier equipo. El navegador es cliente; compartir y controlar Windows requiere el `.exe`.

## Desarrollo y compilación

Node.js22.12 o posterior. Desde la raíz del repositorio:

```sh
npm ci
npm run dev
```

Para la aplicación de escritorio:

```sh
npm run build
npm run desktop
```

La primera ejecución de `desktop` instala el binario oficial de Electron si falta, verificando sus checksums. El ejecutable portable ya construido se puede usar en Windows sin instalar Node.

```sh
npm run build:windows
```

Genera `artifacts/Inhouse-Link-Windows.exe`, su SHA-256 y una copia para la descarga desde la web. Necesita acceso a las distribuciones oficiales de Electron y electron-builder. La firma de código Windows no está incluida.

## Murcia → portátil

1. Despliega la web y señalización con HTTPS y configura STUN/TURN según [deployment.md](docs/deployment.md). Una compilación local no crea un servicio público.
2. Inicia sesión con Google. En **Ajustes → Tu servicio de conexión**, introduce el mismo origen HTTPS y, si se ha configurado, la clave adicional del servicio. Puedes utilizar la web en el portátil. Cambiar de servidor requiere volver a autenticar la cuenta.
3. Junto al PC de Murcia, pulsa **Compartir este PC**, elige pantalla y autoriza el control nativo. Introduce el código desde el portátil.
4. En Murcia elige **Permitir y vincular** para futuras conexiones sin otra aprobación. **Permitir esta vez** no guarda esa autorización.
5. Mantén el PC encendido, desbloqueado, con la app y la captura activas. Reconecta desde **Tus equipos vinculados**. Revoca permisos en Ajustes del anfitrión.

La app Windows usa un origen local estable para conservar su identidad. En la web la vinculación pertenece al navegador y origen utilizados; limpiar sus datos la elimina. No hay autoarranque, servicio Windows ni desbloqueo remoto en esta versión.

## Menú y atajos

| Atajo predeterminado | Acción |
|---|---|
| `Ctrl+Shift+M` | Abrir/cerrar el menú flotante. |
| `Ctrl+Shift+F` | Pantalla completa. |
| `Ctrl+Shift+I` | Capturar ratón para juegos y teclado cuando el entorno lo permita. |
| `Ctrl+Shift+S` | Mostrar/ocultar estadísticas. |
| `Ctrl+Alt+Shift+Q` | Desconectar. |

Los cinco son personalizables. El botón incluye calidad, audio, control, estadísticas, diagnóstico y desconexión. Doble clic en el vídeo activa el ratón relativo; Escape permite salir de la captura. No se pueden reenviar universalmente todas las combinaciones reservadas por Windows o el navegador.

Es un menú propio con funciones comparables. No se afirma paridad completa con todos los ajustes o planes de Parsec: el origen comprobado de cada preset y las diferencias están en [comparison.md](docs/comparison.md).

## Validación

```sh
npm test
npm run typecheck
npm run test:e2e
npm run build
```

Playwright usa Chromium (`CHROMIUM_PATH` configurable). La captura sintética y la frontera nativa Windows se instrumentan en las pruebas; WebRTC, vídeo codificado/decodificado, datos, estadísticas y autenticación son reales. No sustituye una prueba de captura/entrada en Windows ni un benchmark Murcia–Valencia. Los resultados están en [validation.md](docs/validation.md).

## Límites

Pendientes: mandos/vibración, monitor virtual, HDR, 4:4:4, HEVC, archivos, micrófono remoto y servicio Windows. Captura, audio, entrada, DPI y juegos requieren comprobación en Windows real. `SendInput` no controla universalmente ventanas elevadas, escritorio seguro ni juegos con restricciones de entrada. La superioridad global de latencia y fidelidad exige mediciones equivalentes.

## Documentación

- [Cuenta Google: compatibilidad con Notes y Read](docs/google-account.md).
- [Publicación automática de main, Releases y GitHub Pages](docs/publishing.md).
- [Funciones y fortalezas de cada alternativa](docs/comparison.md).
- [41 repositorios públicos y referencias visuales](docs/reference-repositories.md).
- [Despliegue HTTPS/STUN/TURN](docs/deployment.md).
- [Servicio y protocolo](server/README.md).
- [Captura y control Windows](desktop/README.md).
- [Contrato de implementación](IMPLEMENTATION.md).

Se utilizan APIs y dependencias generales como React, Electron y WebRTC con sus licencias. Las fuentes de marca conservan sus licencias OFL en `public/licenses/fonts/`.
