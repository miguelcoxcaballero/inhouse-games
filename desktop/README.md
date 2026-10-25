# Aplicación Windows

`main.cjs` inicia un servidor HTTP únicamente en `127.0.0.1:48715` y abre la interfaz compilada en Electron. El origen fijo conserva las preferencias y las identidades de equipos vinculados entre arranques. Si ese puerto está ocupado por otra aplicación, se muestra un error en lugar de cambiar silenciosamente de origen. La URL del servicio público de señalización se configura desde la interfaz; el servidor local de cada `.exe` no sustituye ese servicio compartido.

La ventana usa un renderer aislado, sin Node.js, sin `webview` y con navegación restringida al origen local. `preload.cjs` expone únicamente operaciones concretas de entrada, nunca acceso general al sistema, ejecución de comandos ni archivos.

## Google en el navegador habitual

La aplicación abre el cliente web autorizado de Google en el navegador externo mediante `https://miguelcoxcaballero.github.io/inhouse-games/#/desktop-auth`. No introduce OAuth en una ventana Electron ni requiere crear un cliente OAuth de escritorio diferente. El broker usa el mismo cliente público y el mismo flujo Google Identity Services que la web de Inhouse Link.

Cada acceso crea una clave ECDH P-256 efímera y un estado aleatorio de 256 bits. El navegador deriva una clave con HKDF SHA-256 y cifra el token de acceso y su caducidad mediante AES-256-GCM, autenticando también ese estado. Devuelve únicamente el resultado cifrado en el fragmento de una navegación a `http://127.0.0.1:48715/auth/google/callback`; no incluye credenciales de Google en parámetros de dirección ni registros. La página local borra el fragmento y entrega el resultado por un POST de su mismo origen.

El proceso principal verifica Host, origen, tamaño, estado, caducidad y cifrado, consume la solicitud una sola vez y devuelve el resultado únicamente al renderer que inició el acceso. Una solicitud nueva, cierre de sesión, recarga, cierre de ventana o espera de cinco minutos invalidan la anterior. La cuenta vuelve a validarse con Google antes de aceptarse en la interfaz. El proceso principal no persiste tokens de Google ni claves de este intercambio.

La URL pública solo admite el host HTTPS y la ruta de este proyecto. `INHOUSE_PUBLIC_APP_URL` o `VITE_PUBLIC_APP_URL` permiten indicar esa misma URL de forma explícita; no convierten el inicio de sesión en una redirección hacia servidores arbitrarios. El servicio local guarda sus sesiones propias en `app.getPath('userData')/account-sessions.json`, fuera del paquete ASAR. Estas sesiones pertenecen a Inhouse y se gestionan separadas del token temporal de Google.

Los tests `desktop/google-auth.test.cjs` ejercitan el cifrado WebCrypto del frontend contra el descifrado Node, manipulación, estado incorrecto, repetición, caducidad, cancelación y restricciones HTTP. El inicio real de Google en Windows requiere el navegador habitual, la publicación del broker y una cuenta autorizada; no se considera validado con credenciales reales por ejecutar estos tests.

## Captura y permiso

Al compartir, un diálogo nativo permite elegir la pantalla. Windows puede incluir audio del sistema cuando el usuario lo ha activado. Otro diálogo pide permiso para controlar teclado y ratón. El permiso queda activo durante esa captura, incluidas las reconexiones autorizadas por la aplicación, y se revoca al dejar de compartir o desactivar el control. La vinculación de equipos y la aprobación de cada conexión pertenecen al servicio de señalización y al motor de sesión.

La selección identifica la pantalla y transforma su rectángulo DIP a píxeles físicos. El auxiliar activa la compatibilidad DPI por monitor para que las coordenadas normalizadas coincidan también en configuraciones con varios monitores y escalados distintos. Los cambios de resolución, escala o disposición actualizan ese rectángulo durante la captura; al desaparecer la pantalla seleccionada, se revoca el control.

## Entrada original

Mientras la captura consentida está activa se mantiene el PC despierto. Al conectarse un cliente, la ventana anfitriona se minimiza para evitar capturar la propia interfaz. El icono Inhouse en la bandeja de Windows permite volver a abrirla o salir y detener la captura. Cerrar la app revoca el permiso; no se instala como servicio.

`native/input.ps1` compila una clase C# original que usa `SendInput` de Win32. El proceso se inicia con una ruta fija, `shell:false` y un protocolo JSON limitado por stdin. Los eventos no se interpolan en código ni se ejecutan como comandos. La política `RemoteSigned` se aplica exclusivamente a ese proceso de PowerShell; no se cambian preferencias del equipo.

`input-validation.cjs` valida tipos, rangos y códigos de tecla antes de comunicar con el auxiliar. Este registra las teclas y botones mantenidos y los libera al desconectar, cerrar, revocar permiso o cerrarse stdin. Se soportan coordenadas absolutas, desplazamiento relativo para bloqueo de puntero, tres botones, rueda vertical/horizontal y códigos físicos de teclado.

No se emula un mando virtual. Los juegos con entrada protegida o software antitrampas pueden rechazar `SendInput`; tampoco se controla el escritorio seguro de UAC ni se envía la combinación protegida Ctrl+Alt+Supr. No se requiere ni se instala ningún controlador de kernel.

## Empaquetado

`npm run build:windows` crea el portable `artifacts/Inhouse-Link-Windows.exe`. `npm run build:installer` crea un instalador NSIS independiente, `artifacts/Inhouse-Link-Setup-0.2.0.exe`, y su SHA-256. El asistente instala para el usuario actual, permite elegir carpeta y crea accesos en escritorio/menú Inicio y una entrada de desinstalación de Windows. No solicita elevación; al desinstalar conserva las preferencias y vinculaciones del usuario. Ambos paquetes contienen la misma aplicación x64.

En Linux, `scripts/build-installer.mjs` usa el parser `UninstallerReader` incluido en electron-builder 26.18 para extraer el desinstalador intermedio generado por NSIS, igual que su implementación para macOS. Así no ejecuta un programa Windows durante el empaquetado ni necesita Wine. En Windows utiliza el proceso normal de electron-builder. La verificación posterior exige el paquete x64 y el desinstalador completos y comprueba sus CRC y los hashes de la aplicación incluida antes de emitir el SHA-256.

El paquete debe conservar `asarUnpack: ["desktop/native/**/*"]`: PowerShell necesita un archivo real fuera de `app.asar`. El artefacto portable es x64. El ejecutable no se presenta como firmado si no se ha aplicado un certificado de firma.

## Validación en Windows pendiente de hardware

Las comprobaciones de sintaxis JavaScript y los tests del filtro de entrada se ejecutan en Linux. La captura, el audio loopback, la ejecución C#/Win32 y los siguientes pasos requieren dos equipos Windows:

1. Ejecutar el `.exe`, elegir servicio compartido y comenzar a compartir.
2. Elegir monitor, permitir control y vincular el portátil explícitamente.
3. Conectar desde navegador y desde el `.exe` del portátil. Comprobar vídeo, audio, teclado, tres botones y rueda.
4. Repetir con pantalla secundaria, escalado 125/150 %, coordenadas negativas y bloqueo de puntero en un juego compatible.
5. Desconectar con teclas mantenidas: confirmar liberación. Reconectar como equipo vinculado sin otra aprobación, conservando la captura.
6. Desactivar el control o dejar de compartir: confirmar que no se aceptan eventos y que otra sesión requiere nuevo consentimiento local.

Esas pruebas manuales no se consideran completadas por crear un `.exe` desde Linux.
