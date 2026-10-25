# Funciones comparadas y objetivos de inhouse link

Consulta de referencias realizada el 25 de octubre de 2026. Esta comparación describe funciones documentadas y decisiones de producto; no contiene una prueba de rendimiento entre programas. No se ha copiado su implementación.

El caso de uso es un PC Windows de juegos en Murcia y un portátil Windows —o un navegador— en Valencia u otra ubicación. La calidad y la respuesta dependen de ambos equipos, sus pantallas y la ruta de red. No se puede afirmar que una implementación nueva supere a todos estos productos sin medirla en condiciones equivalentes.

## Qué aporta cada alternativa

| Producto | Fortalezas funcionales para este caso | Coste o límite relevante |
|---|---|---|
| **Sunshine + Moonlight** | Combinación especializada en streaming de juegos: aceleración por GPU, varios códecs, HDR, audio multicanal y mandos. Moonlight tiene clientes nativos para numerosos dispositivos. | Hay que configurar el anfitrión y resolver el acceso desde Internet. La interfaz web de Sunshine configura el servidor; no sustituye al cliente de streaming Moonlight. |
| **Apollo** | Aporta una pantalla virtual integrada en Windows que adapta resolución y frecuencia a cada cliente; permisos por dispositivo, sincronización de portapapeles y modo solo entrada. | El soporte de pantalla virtual descrito es específico de Windows. El proyecto advierte que su compatibilidad futura con Moonlight/Sunshine originales puede cambiar. Artemis, su cliente asociado, se documenta actualmente para Android. |
| **RustDesk** | Sobresale como herramienta de administración y escritorio remoto: ID/contraseña, acceso desatendido, portapapeles, transferencia de archivos, túneles TCP y servidores de encuentro/relay propios. | Tener códecs acelerados no demuestra una respuesta equivalente a un producto de gaming. El servidor OSS y el servidor Pro tienen funciones distintas. |
| **Parsec** | Referencia comercial del flujo que solicita el usuario: conexión interactiva entre equipos, aplicación de escritorio y controles durante la sesión. Sus herramientas públicas también contemplan aprovisionamiento de equipos Teams y acceso de invitados. | La aplicación no es un proyecto abierto equivalente a Sunshine o RustDesk. No se ha podido auditar aquí el catálogo vigente de planes, ajustes y atajos de su centro de ayuda. |

“Fortaleza” significa que esa función encaja bien con el objetivo; no equivale a una clasificación de velocidad o calidad visual medida.

## Compatibilidad y funciones documentadas

| Área | Sunshine + Moonlight | Apollo | RustDesk | Parsec |
|---|---|---|---|---|
| Código abierto | Sunshine y Moonlight PC: GPLv3. | GPLv3; derivado de Sunshine. | Cliente y servidor OSS abiertos; existen ofertas Pro separadas. | Herramientas y bibliotecas auxiliares públicas; no el código completo de la aplicación comercial. |
| Windows | Anfitrión Sunshine y cliente Moonlight PC. | Anfitrión; pantalla virtual integrada. | Cliente/anfitrión y despliegue como servicio. | Es el caso de referencia del usuario y de la herramienta oficial de preparación de Windows cloud consultada. |
| Otros sistemas | Sunshine documenta varios anfitriones; Moonlight tiene clientes Windows, macOS, Linux, Android e iOS, entre otros. La función concreta depende de la plataforma. | Base multiplataforma; no asumir que todas sus funciones exclusivas estén disponibles fuera de Windows. | Windows, macOS, Linux, Android, iOS y web; iOS no se puede controlar remotamente. | La lista vigente de plataformas de la aplicación no se ha contrastado aquí. La lista de `libmatoya` no debe confundirse con la del producto Parsec. |
| Navegador | Panel web de configuración de Sunshine; los clientes Moonlight citados son aplicaciones. | Panel de configuración; no se verificó un cliente web oficial de streaming. | Cliente web documentado; revisar los requisitos del despliegue y edición elegidos. | El visor web y sus límites actuales requieren verificación con la documentación del producto. |
| Vídeo | Moonlight PC documenta H.264, HEVC y AV1, con hardware compatible. | Hereda el enfoque de streaming de Sunshine; no se atribuye aquí una matriz idéntica de códecs sin verificar cada versión. | La documentación enumera VP8/VP9/AV1 por software y H.264/H.265 por hardware. | No se presenta aquí una lista actual de códecs sin documentación de producto verificable. |
| Alta fidelidad | Moonlight PC documenta YUV 4:4:4 y HDR; no todos los equipos/modos los ofrecen. | Pantalla virtual con HDR documentado, sujeto al sistema y hardware. | La matriz completa HDR/4:4:4 no se verificó en las fuentes consultadas. | La matriz completa HDR/4:4:4 y sus posibles requisitos de plan no se verificó aquí. |
| Monitor virtual | No se atribuye un controlador virtual integrado a la combinación básica consultada. | Es una función destacada: creación al iniciar sesión, resolución/frecuencia automática e identidad por cliente. | No se auditó su compatibilidad concreta con pantallas virtuales. | No se verificaron los requisitos vigentes de controlador/plan. |
| Internet y NAT | La guía ofrece UPnP, reenvío de puertos, IPv6 y redes privadas virtuales. CGNAT puede requerir una solución adicional. | Requiere resolver también la conectividad entre equipos; la pantalla virtual no resuelve NAT. | Servidor de encuentro y conexiones directas o mediante relay; puede autoalojarse. | No se auditó aquí su infraestructura ni los modos de conexión actuales. |
| Acceso sin una nueva aprobación manual | Dispositivos previamente emparejados, con anfitrión disponible. | Clientes previamente emparejados y permisos persistentes. | Contraseña permanente y controles de servicio documentados. | Sus herramientas Teams contemplan asignación de equipos/usuarios; el flujo personal vigente requiere verificación. |
| Mandos | Moonlight documenta mandos, vibración y funciones adicionales, condicionadas por anfitrión y controladores. | Hereda capacidades de streaming; revisar controladores y versión elegidos. | La documentación consultada no demuestra equivalencia con una solución de gaming para mandos. | La herramienta cloud oficial hace referencia a un controlador Xbox virtual; no se auditó aquí toda la matriz actual. |

En particular, el README actual de Sunshine distingue perfiles de mando que necesitan un controlador instalado por separado. No debe confundirse la licencia libre del programa con que todos los controladores opcionales tengan las mismas condiciones.

## Menú flotante y atajos

La implementación de inhouse link incorpora un botón propio con el tejado y la identidad Inhouse. El objetivo es acceder a los controles sin salir del vídeo. No se utiliza el logotipo ni se copia la interfaz o implementación de Parsec.

No se pudo verificar el inventario completo y actual del menú de Parsec: su centro de ayuda no está entre los destinos disponibles en esta máquina. Se revisaron los repositorios públicos de la organización oficial `parsec-cloud`; la documentación del antiguo SDK no estaba disponible en la ubicación examinada. Por ello, **“todos los mismos ajustes y atajos de Parsec” permanece pendiente de contraste y paridad funcional**.

| Combinación | Función de inhouse link | Procedencia comprobada |
|---|---|---|
| `Ctrl+Shift+M` | Abrir/cerrar el menú durante la sesión. | Preset familiar adoptado por este proyecto; equivalencia actual con Parsec no comprobada en una fuente oficial accesible. |
| `Ctrl+Shift+F` | Alternar pantalla completa. | Preset familiar adoptado por este proyecto; equivalencia actual con Parsec no comprobada en una fuente oficial accesible. |
| `Ctrl+Shift+I` | Activar/liberar el ratón para juegos mediante pointer lock; solicitar captura de teclas cuando el navegador lo permite. | **Sí confirmado para Parsec** como entrada al modo inmersivo en el README oficial de su herramienta de preparación cloud. Inhouse implementa su propia captura; no se promete que las combinaciones reservadas se comporten igual en todos los sistemas. |
| `Ctrl+Shift+S` | Mostrar/ocultar estadísticas. | Atajo propio de inhouse link; no se presenta como un atajo Parsec comprobado. |
| `Ctrl+Alt+Shift+Q` | Desconectar la sesión. | Coincide con el atajo documentado de **Moonlight**, no se atribuye a Parsec. |

Estos son los valores predeterminados: los cinco atajos de inhouse link se pueden personalizar en Ajustes y se conservan localmente. La interfaz rechaza combinaciones duplicadas y permite restaurar los valores iniciales.

La guía oficial de Moonlight también documenta `Ctrl+Alt+Shift+Z` para captura, `Ctrl+Alt+Shift+X` para pantalla completa y `Ctrl+Alt+Shift+S` para estadísticas. Estas combinaciones no deben etiquetarse como equivalencias Parsec.

Un navegador no puede reenviar de forma universal todas las combinaciones reservadas por Windows ni generar una secuencia de atención segura como `Ctrl+Alt+Supr`. El modo de entrada de inhouse link debe comunicar esas limitaciones y conservar una salida local de la sesión.

## Estado de la implementación propia

Esta tabla distingue el trabajo presente en el código de las capacidades que necesitan desarrollo o validación adicional. Los resultados de compilación y pruebas de la entrega se registran por separado en el README y en el informe final.

| Área | Presente en la implementación | Límite o trabajo pendiente |
|---|---|---|
| Cliente web | Interfaz React original, conexión por código, recepción de vídeo/audio y controles de sesión. | No funciona como anfitrión de control nativo de Windows. Requiere un anfitrión y un servidor de señalización alcanzable. |
| Aplicación Windows | Contenedor Electron para actuar como anfitrión o cliente y captura consentida de pantalla. | Debe validarse en Windows real; compilar un `.exe` no demuestra captura, audio, compatibilidad de juegos ni rendimiento. |
| Transporte | WebRTC con medios cifrados y canal de datos; señalización propia, primera aprobación local y reconexión de dispositivos vinculados. | Para redes diferentes hacen falta un despliegue alcanzable y servidores STUN/TURN configurados según la topología. No existe un servicio mundial ya provisionado por el mero hecho de compilar. |
| Vinculación y acceso desatendido | «Permitir y vincular» autoriza al portátil a volver a conectar sin otra aprobación. El usuario puede quitar un PC de su lista y revocar todos los dispositivos autorizados desde el anfitrión. | Requiere la primera autorización local y que el PC siga encendido, con la aplicación abierta y compartiendo pantalla. No incorpora autoarranque ni un servicio Windows que comparta tras reiniciar o antes de iniciar sesión. |
| Identidad de los equipos | Identidad persistente del anfitrión con ECDSA P-256. La vinculación intercambia un token aleatorio por el canal de datos DTLS; las reconexiones comprueban pruebas HMAC-SHA-256 ligadas al nonce de conexión y al anfitrión, con prueba mutua. | El material se conserva en el almacenamiento local de cada perfil. Borrar esos datos obliga a vincular de nuevo; no existe sincronización de credenciales entre perfiles. Esto describe el mecanismo implementado, no una auditoría de seguridad independiente. |
| Calidad | Ajustes de resolución, objetivo 30/60/120 FPS, límite de bitrate, preferencia de códec y adaptación. | Son objetivos negociados: no garantizan esa resolución/FPS ni aceleración hardware en cualquier equipo. HEVC, HDR y 4:4:4 no están implementados como funciones propias verificadas. |
| Códecs | Preferencias automático, H.264, VP9 y AV1, negociadas con las capacidades WebRTC disponibles. | AV1 puede no estar disponible o no estar acelerado; no se promete que sea la opción de menor latencia. |
| Teclado y ratón | Canal de entrada, autorización explícita, ratón absoluto/relativo, pointer lock y puente nativo limitado al anfitrión Windows. | Validar juegos concretos, distribución de teclado, DPI/múltiples pantallas y aplicaciones elevadas. No equivale a un controlador de entrada de kernel. |
| Sonido | Transporte de audio cuando la captura del sistema lo proporciona y control de silencio. | Validar audio de juegos y dispositivos en Windows. Micrófono remoto y audio multicanal avanzado no están verificados. |
| Menú | Botón flotante Inhouse, calidad, audio, estadísticas, control, ratón para juegos, pantalla completa, exportación de diagnóstico y desconexión; atajos personalizables. | No se afirma paridad completa con las versiones y planes actuales de Parsec. |
| Telemetría | RTT, decodificación, bitrate, FPS, pérdida, resolución, códec y ruta cuando WebRTC los proporciona. | El RTT de red no es latencia total de entrada a pantalla. No se inventan valores cuando no hay datos. |
| Funciones avanzadas | Base propia autoalojable, vinculación persistente de equipos y reconexión sin aprobación repetida mientras el anfitrión comparte. | Mandos/vibración, monitor virtual, HDR, 4:4:4, autoarranque/servicio Windows, Wake-on-LAN y transferencia de archivos necesitan trabajo adicional. |

## Cómo demostrar una mejora real

Para comparar con los otros productos se necesitan las mismas máquinas, juego/escena, resolución, frecuencia, pantalla y condiciones de red. Conviene medir al menos:

1. **Respuesta completa:** tiempo desde una entrada hasta que cambia la imagen en el portátil, idealmente con medición externa; informar mediana y percentiles, no solo ping.
2. **Estabilidad:** FPS entregados, fotogramas perdidos, variación de retardo, desconexiones y reconexión.
3. **Fidelidad a igual caudal:** capturas de la misma escena, texto y movimiento; evaluar artefactos, detalle, color y métricas de imagen cuando proceda.
4. **Coste en ambos equipos:** uso de CPU/GPU, energía y carga adicional sobre el juego.
5. **Conectividad:** LAN, Murcia–Valencia y una red externa más restrictiva; distinguir conexión directa de relay y repetir con variaciones de ancho de banda y pérdidas.

Hasta ejecutar esas pruebas, la ventaja demostrable de esta versión es su implementación propia, control del despliegue e integración visual Inhouse. La superioridad global de latencia, fidelidad y compatibilidad sigue siendo un objetivo, no un resultado medido.

## Fuentes

- [Sunshine: descripción y tablas de compatibilidad](https://github.com/LizardByte/Sunshine#readme).
- [Licencia de Sunshine](https://github.com/LizardByte/Sunshine/blob/master/LICENSE).
- [Moonlight PC: funciones, códecs, HDR y dispositivos](https://github.com/moonlight-stream/moonlight-qt#features).
- [Licencia de Moonlight PC](https://github.com/moonlight-stream/moonlight-qt/blob/master/LICENSE).
- [Guía oficial Moonlight: Internet, NAT y atajos](https://github.com/moonlight-stream/moonlight-docs/wiki/Setup-Guide).
- [Apollo: pantalla virtual, permisos y advertencia de compatibilidad futura](https://github.com/ClassicOldSong/Apollo#readme).
- [RustDesk: estructura, conexiones y funciones de escritorio](https://github.com/rustdesk/rustdesk#readme).
- [RustDesk: documentación oficial de plataformas y códecs](https://github.com/rustdesk/doc.rustdesk.com/blob/master/content/_index.en.md).
- [RustDesk: configuración del cliente, servicio y contraseña permanente](https://github.com/rustdesk/doc.rustdesk.com/blob/master/content/client/_index.en.md).
- [RustDesk Server OSS: encuentro y relay](https://github.com/rustdesk/rustdesk-server#readme).
- [Organización oficial Parsec y repositorios públicos disponibles](https://github.com/orgs/parsec-cloud/repositories).
- [Parsec Cloud Preparation Tool: uso cloud, Teams y `Ctrl+Shift+I`](https://github.com/parsec-cloud/Parsec-Cloud-Preparation-Tool#readme).
- [libmatoya: biblioteca auxiliar; su compatibilidad no es la de la aplicación Parsec](https://github.com/parsec-cloud/libmatoya#readme).

Las funciones cambian por versión y hardware. Las fuentes se consultaron como documentación; no se integró su código en el motor de inhouse link.
