# Pruebas y alcance de la validación

`npm test` comprueba señalización, autorización, validación de mensajes, credenciales TURN y filtro nativo de entrada. `npm run typecheck` y `npm run build` validan tipos y el paquete web.

`npm run test:e2e` usa Chromium y Playwright. `CHROMIUM_PATH` permite seleccionar el ejecutable. La configuración usa `/usr/bin/chromium` en esta máquina cloud.

## Requisito de las pruebas de streaming

Instala **coturn** mediante el gestor de paquetes de tu distribución y comprueba que `turnserver` está en `PATH`. También puedes indicar `COTURN_BIN` y, si se extrajo sin instalar sus bibliotecas, `COTURN_LIB_DIR`.

En la imagen Debian 13 x64 de esta tarea se puede instalar la herramienta de prueba sin privilegios:

```bash
python3 scripts/install-test-coturn.py
npm run test:e2e
```

El script usa el llavero Debian existente y `sqv` para verificar `InRelease`, comprueba el SHA256 del índice firmado y de cada paquete, y extrae coturn y tres bibliotecas necesarias en `../.tools/coturn`. No modifica archivos del sistema ni políticas del navegador. En otras distribuciones, utiliza la instalación oficial de coturn correspondiente a tu sistema.

## Qué comprueban los E2E de streaming

Las pruebas arrancan un coturn TCP autenticado que escucha únicamente en loopback y un servicio de señalización efímero con clave de acceso. Las credenciales se generan durante la ejecución, se mantienen en memoria y no pertenecen a ningún despliegue real. Los procesos y las pistas se cierran al terminar.

Este Chromium cloud configura `WebRtcIPHandling=disable_non_proxied_udp`; por ello se comprueba una **ruta relay real** en lugar de cambiar la política gestionada. El relay permite tráfico local entre los dos participantes de la prueba; esa configuración de loopback no debe trasladarse a producción.

Solo se sustituyen dos límites de hardware: el selector de pantalla entrega un canvas animado con audio sintético, y el bridge de Windows registra las llamadas que normalmente recibe Win32. No se simulan `RTCPeerConnection`, SDP, ICE, canales de datos, codificación, decodificación ni estadísticas.

Los escenarios verifican:

- Vídeo recibido con resolución válida y fotogramas que avanzan, y medidas reales de FPS, bitrate, códec, ruta y tiempo de decodificación.
- Teclado y ratón a través del canal de datos hasta el bridge nativo, y modificación efectiva de `RTCRtpSender.maxBitrate` desde el otro equipo.
- Desconexión del cliente sin detener la captura del anfitrión y revocación al dejar de compartir.
- Vinculación explícita, reconexión con comprobaciones criptográficas mutuas y solicitud manual cuando se altera una credencial.
- Denegación de entrada en el anfitrión sin permiso incluso si un cliente evita su propia restricción y escribe directamente en el canal de datos.
- Reinicio real del servicio de señalización en el mismo puerto: el anfitrión conserva identidad, captura y permiso, se registra otra vez y admite la reconexión del portátil vinculado.
- Flujo de interfaz completo: compartir, código, aprobar, reproducir vídeo, abrir el menú flotante, mostrar estadísticas, cambiar calidad, arrastrar y guardar posición, alternar pantalla completa y desconectar mediante atajos.

Las pruebas de interfaz cubren identidad visual, ajustes persistentes, validación de direcciones, errores honestos y disposición móvil. Las validaciones de captura física, audio loopback e inyección Win32 requieren Windows: véase [la lista manual de escritorio](../desktop/README.md).

Estas pruebas no miden latencia entre Murcia y Valencia, no comparan rendimiento con otros productos y no validan HDR, mandos virtuales, antitrampas ni juegos concretos.
