# inhouse link

Streaming remoto propio para un PC Windows y un cliente web o Windows. El PC ejecuta los juegos; el cliente recibe vídeo y audio y devuelve teclado y ratón por WebRTC. La versión 0.3 conecta los equipos de la misma cuenta Google sin activar un servidor ni introducir códigos. Usa el cliente OAuth y el flujo de Inhouse Notes y Read. Su rendimiento frente a las alternativas debe medirse en los equipos reales.

Identidad contrastada con los proyectos de Inhouse: casa, nombres en minúsculas, Comfortaa + DM Sans, naranja `#E07A3C`, crema y superficies oscuras. La lógica es original; no se utiliza Parsec, Sunshine, Moonlight, Apollo ni RustDesk como motor.

## Funciones

- Web pública de producto y descargas; cliente en `#/client`, descargas en `#/downloads`.
- Google Identity Services, mismo cliente OAuth y permiso `drive.file` de Inhouse Read. Tras verificar el perfil, obtiene o crea un pequeño archivo privado en Drive con la clave de conexión de esa cuenta. No necesita una cuenta nueva de hosting ni un secreto OAuth en el cliente.
- Capacidad privada local de hasta 30 días, independiente de la caducidad del token Google. El acceso OAuth no se prolonga ni se guarda en esa sesión.
- Login Windows en el navegador externo, con transferencia cifrada de un solo uso. El proceso principal guarda su autorización de cuenta protegida con DPAPI en Windows.
- Los PCs disponibles de la misma cuenta aparecen automáticamente. Puedes conectar sin que otra persona acepte en el anfitrión, mientras la app siga abierta y su disponibilidad esté activada.
- Cliente web y aplicación Windows; Windows permite actuar como anfitrión y como cliente.
- Captura consentida de pantalla y audio loopback de Windows cuando está disponible.
- Medios cifrados por WebRTC, canal fiable para teclado/botones y canal de baja espera para movimientos del ratón.
- Presencia y señalización MQTT firmadas con identidad P-256 y cifradas con AES-GCM; pruebas HMAC independientes autorizan el control nativo. Las invitaciones manuales para otras cuentas conservan aprobación y vinculación en el modo Node opcional.
- Control Win32 propio: teclado, ratón absoluto/relativo, botones y rueda. No ejecuta comandos arbitrarios del cliente.
- Botón Inhouse flotante y arrastrable, ajustes en directo, pantalla completa, captura del ratón y estadísticas reales.
- Resolución solicitada, 30/60/120 FPS, bitrate, H.264/VP9/AV1 según capacidades, audio y adaptación al enlace.
- Exportación de diagnóstico sin claves ni contenido de pantalla. `node scripts/benchmark.mjs captura.json` calcula mediana y percentil95.
- Modo avanzado opcional: señalización Node autoalojada, STUN/TURN configurable y clave adicional de servicio.

Los objetivos de calidad se negocian: no garantizan esa resolución/FPS ni aceleración GPU en cualquier equipo. El navegador es cliente; compartir y controlar Windows requiere el `.exe`.

El modo habitual usa `wss://public.cloud.shiftr.io` por TCP443 para descubrir equipos e intercambiar señalización cifrada. Es un servicio público gratuito de pruebas de un tercero, sin SLA propio de Inhouse. Nombres, perfiles, tokens y claves no se envían al broker en texto claro; este puede observar metadatos de conexión y tráfico. El vídeo, audio y controles viajan por WebRTC, con STUN de Google para buscar una ruta directa. **No hay un relay TURN público configurado:** ciertas redes con NAT o cortafuegos restrictivos pueden impedir la conexión.

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

1. Abre la aplicación Windows 0.3 en el PC de Murcia e inicia sesión con Google. Si vienes de una versión anterior, vuelve a iniciar sesión una vez para crear la autorización nativa protegida.
2. Mantén activada **Disponible para ti** y deja la aplicación en ejecución. No necesitas activar Render, contratar un servidor ni copiar un código.
3. Abre el [cliente web](https://miguelcoxcaballero.github.io/inhouse-games/#/client) o la aplicación Windows en el portátil e inicia sesión con **la misma cuenta Google**.
4. Elige el PC en línea y pulsa **Conectar**. No se solicita aceptación en el PC de Murcia para los dispositivos de esa cuenta.
5. Mantén el PC encendido, desbloqueado y con la app abierta. Desactiva su disponibilidad o cierra sesión para retirar el acceso.

Si configuraste una dirección de servicio personalizada anteriormente, elimínala de Ajustes para volver al modo por cuenta. El servidor Node y Render quedan como alternativas avanzadas en [deployment.md](docs/deployment.md).

La app Windows usa un origen local estable para conservar su identidad. En la web la capacidad pertenece al navegador y origen utilizados; limpiar sus datos exige volver a entrar con Google. No hay autoarranque, servicio Windows ni desbloqueo remoto en esta versión.

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

Playwright usa Chromium (`CHROMIUM_PATH` configurable). Las pruebas de MQTT usan un broker local real; por separado se comprueban WebRTC, vídeo codificado/decodificado, audio, datos y estadísticas reales. Google responde mediante fixtures y la captura física y la frontera nativa Windows se instrumentan. Los resultados y el alcance de cada prueba están en [validation.md](docs/validation.md).

La política de red del entorno cloud impide verificar el broker público Shiftr. Quedan pendientes el consentimiento con Google real, la disponibilidad de ese servicio desde las redes del usuario, captura/control en Windows físico y la conexión Murcia–Valencia. Las pruebas locales no acreditan esos resultados.

## Límites

Pendientes: mandos/vibración, monitor virtual, HDR, 4:4:4, HEVC, archivos, micrófono remoto y servicio Windows. Captura, audio, entrada, DPI y juegos requieren comprobación en Windows real. `SendInput` no controla universalmente ventanas elevadas, escritorio seguro ni juegos con restricciones de entrada. La superioridad global de latencia y fidelidad exige mediciones equivalentes.

## Documentación

- [Cuenta Google: compatibilidad con Notes y Read](docs/google-account.md).
- [Publicación automática de main, Releases y GitHub Pages](docs/publishing.md).
- [Funciones y fortalezas de cada alternativa](docs/comparison.md).
- [41 repositorios públicos y referencias visuales](docs/reference-repositories.md).
- [Conexión por cuenta y opciones avanzadas HTTPS/STUN/TURN](docs/deployment.md).
- [Servicio y protocolo](server/README.md).
- [Captura y control Windows](desktop/README.md).
- [Contrato de implementación](IMPLEMENTATION.md).

Se utilizan APIs y dependencias generales como React, Electron y WebRTC con sus licencias. Las fuentes de marca conservan sus licencias OFL en `public/licenses/fonts/`.
