# Aplicación Windows

`main.cjs` inicia un servidor HTTP únicamente en `127.0.0.1:48715` para abrir la interfaz compilada y recibir el acceso de Google. El origen fijo conserva preferencias e identidades entre arranques. Si el puerto está ocupado, se muestra un error en lugar de cambiar silenciosamente de origen. La conexión habitual utiliza la cuenta de Google, un archivo privado de conexión en Drive y señalización cifrada mediante el transporte de la aplicación; no requiere que el usuario active un backend. El servicio Node permanece como opción avanzada independiente.

La ventana usa un renderer aislado, sin Node.js, sin `webview` y con navegación restringida al origen local. `preload.cjs` expone únicamente operaciones concretas de entrada, nunca acceso general al sistema, ejecución de comandos ni archivos.

## Google en el navegador habitual

La aplicación abre el cliente web autorizado de Google en el navegador externo mediante `https://miguelcoxcaballero.github.io/inhouse-games/#/desktop-auth`. No introduce OAuth en una ventana Electron ni requiere crear un cliente OAuth de escritorio diferente. El broker usa el mismo cliente público y el mismo flujo Google Identity Services que la web de Inhouse Link.

Cada acceso crea una clave ECDH P-256 efímera y un estado aleatorio de 256 bits. El navegador deriva una clave con HKDF SHA-256 y cifra el token de acceso y su caducidad mediante AES-256-GCM, autenticando también ese estado. Devuelve únicamente el resultado cifrado en el fragmento de una navegación a `http://127.0.0.1:48715/auth/google/callback`; no incluye credenciales de Google en parámetros de dirección ni registros. La página local borra el fragmento y entrega el resultado por un POST de su mismo origen.

El proceso principal verifica Host, origen, tamaño, estado, caducidad y cifrado, consume la solicitud una sola vez y devuelve el resultado únicamente al renderer que inició el acceso. Una solicitud nueva, cierre de sesión, recarga, cierre de ventana o espera de cinco minutos invalidan la anterior. La cuenta vuelve a validarse con Google antes de aceptarse en la interfaz. El proceso principal no persiste tokens de Google ni claves de este intercambio.

La URL pública solo admite el host HTTPS y la ruta de este proyecto. `INHOUSE_PUBLIC_APP_URL` o `VITE_PUBLIC_APP_URL` permiten indicar esa misma URL de forma explícita; no convierten el inicio de sesión en una redirección hacia servidores arbitrarios.

En el modo habitual, el proceso principal obtiene él mismo el archivo privado de conexión de Drive después de verificar la cuenta con Google. Guarda su clave y el perfil durante 30 días mediante `safeStorage` de Electron —DPAPI en Windows— en `app.getPath('userData')/native-cloud-account.bin`. No persiste el token OAuth de Google. Si no hay almacenamiento protegido disponible, mantiene la sesión solo en memoria, sin archivo de texto alternativo. Restaurar una sesión nunca amplía su caducidad. Cerrar sesión elimina la copia local; no borra ni comparte el archivo privado de Drive.

En el modo Node opcional, el servicio local guarda sus sesiones propias en `app.getPath('userData')/account-sessions.json`, fuera del paquete ASAR. Estas sesiones se gestionan separadas del token temporal de Google y de la cuenta privada de Drive.

Los tests `desktop/google-auth.test.cjs` ejercitan el cifrado WebCrypto del frontend contra el descifrado Node, manipulación, estado incorrecto, repetición, caducidad, cancelación y restricciones HTTP. El inicio real de Google en Windows requiere el navegador habitual, la publicación del broker y una cuenta autorizada; no se considera validado con credenciales reales por ejecutar estos tests.

## Captura y permiso

Para los equipos de tu propia cuenta, el cliente Windows puede quedar disponible automáticamente después del acceso de Google. La captura automática utiliza la pantalla principal sin selector ni aprobación por conexión; el cliente web continúa siendo un visor. Windows puede incluir audio del sistema cuando el usuario lo ha activado. Desconectar al visitante libera teclado y ratón y conserva el anfitrión disponible.

Esta automatización no depende de una bandera o una clave enviada por el renderer. En el modo habitual, el proceso principal verifica con Google la identidad recibida del broker, obtiene por su cuenta el archivo privado de Drive y conserva la clave protegida. El frontend no puede reemplazar esa clave mediante IPC. La sesión local de 30 días no depende de mantener vivo el permiso OAuth de una hora. Cambiar la cuenta o cerrar sesión invalida la autoridad activa.

Para habilitar entrada sin diálogo, el anfitrión crea un desafío aleatorio nuevo y comprueba una prueba HMAC con su clave privada de cuenta. La prueba vincula cuenta, anfitrión, visitante, conexión, desafío, fecha y propósito. Cada conexión se consume una sola vez. Las confirmaciones posteriores requieren un contador estrictamente creciente y mantienen un permiso nativo de 45 segundos. Se rechazan otra cuenta, otra clave, otra conexión, pruebas antiguas y repeticiones. Si dejan de llegar confirmaciones válidas, se libera la entrada sin apagar la disponibilidad del anfitrión.

El modo Node opcional conserva su autorización independiente: verifica la sesión y consulta `GET /api/account/connection/:id` con la credencial del anfitrión. Deben coincidir cuenta, equipo y conexión activa. Sus permisos duran como máximo 60 segundos y se vuelven a comprobar cada 30 segundos. La vinculación local de hash, origen, equipo y cuenta permite restaurar su sesión de 30 días sin guardar credenciales de Google.

Los flujos manuales del modo Node para otra cuenta conservan el consentimiento del anfitrión. Al compartir manualmente sin autoridad de cuenta, un diálogo nativo permite elegir pantalla y otro pide permiso para teclado y ratón. La vinculación HMAC de dispositivos sigue siendo independiente de la cuenta. Desactivar el acceso del equipo, dejar de compartir o cerrar sesión revoca captura y control.

La selección identifica la pantalla y transforma su rectángulo DIP a píxeles físicos. El auxiliar activa la compatibilidad DPI por monitor para que las coordenadas normalizadas coincidan también en configuraciones con varios monitores y escalados distintos. Los cambios de resolución, escala o disposición actualizan ese rectángulo durante la captura; al desaparecer la pantalla seleccionada, se revoca el control.

## Entrada original

Mientras la captura consentida está activa se mantiene el PC despierto. Al conectarse un cliente, la ventana anfitriona se minimiza para evitar capturar la propia interfaz. El icono Inhouse en la bandeja de Windows permite volver a abrirla o salir y detener la captura. Cerrar la app revoca el permiso; no se instala como servicio.

La ventana mantiene los temporizadores activos en segundo plano para que minimizarla no retrase los avisos de disponibilidad ni las renovaciones de los permisos de entrada.

`native/input.ps1` compila una clase C# original que usa `SendInput` de Win32. El proceso se inicia con una ruta fija, `shell:false` y un protocolo JSON limitado por stdin. Los eventos no se interpolan en código ni se ejecutan como comandos. La política `RemoteSigned` se aplica exclusivamente a ese proceso de PowerShell; no se cambian preferencias del equipo.

`input-validation.cjs` valida tipos, rangos y códigos de tecla antes de comunicar con el auxiliar. Este registra las teclas y botones mantenidos y los libera al desconectar, cerrar, revocar permiso o cerrarse stdin. Se soportan coordenadas absolutas, desplazamiento relativo para bloqueo de puntero, tres botones, rueda vertical/horizontal y códigos físicos de teclado.

No se emula un mando virtual. Los juegos con entrada protegida o software antitrampas pueden rechazar `SendInput`; tampoco se controla el escritorio seguro de UAC ni se envía la combinación protegida Ctrl+Alt+Supr. No se requiere ni se instala ningún controlador de kernel.

## Empaquetado

`npm run build:windows` crea el portable `artifacts/Inhouse-Link-Windows.exe`. `npm run build:installer` crea un instalador NSIS independiente, `artifacts/Inhouse-Link-Setup-0.3.0.exe`, y su SHA-256. El asistente instala para el usuario actual, permite elegir carpeta y crea accesos en escritorio/menú Inicio y una entrada de desinstalación de Windows. No solicita elevación; al desinstalar conserva las preferencias y vinculaciones del usuario. Ambos paquetes contienen la misma aplicación x64.

En Linux, `scripts/build-installer.mjs` usa el parser `UninstallerReader` incluido en electron-builder 26.18 para extraer el desinstalador intermedio generado por NSIS, igual que su implementación para macOS. Así no ejecuta un programa Windows durante el empaquetado ni necesita Wine. En Windows utiliza el proceso normal de electron-builder. La verificación posterior exige el paquete x64 y el desinstalador completos y comprueba sus CRC y los hashes de la aplicación incluida antes de emitir el SHA-256.

El paquete debe conservar `asarUnpack: ["desktop/native/**/*"]`: PowerShell necesita un archivo real fuera de `app.asar`. El artefacto portable es x64. El ejecutable no se presenta como firmado si no se ha aplicado un certificado de firma.

## Validación en Windows pendiente de hardware

Las comprobaciones de sintaxis JavaScript y los tests del filtro de entrada se ejecutan en Linux. La captura, el audio loopback, la ejecución C#/Win32 y los siguientes pasos requieren dos equipos Windows:

1. Ejecutar el `.exe` e iniciar sesión con la misma cuenta de Google en ambos equipos, sin activar un backend.
2. Comprobar que el PC aparece disponible y conectar desde el otro equipo sin aprobar una solicitud en el anfitrión. Comprobar vídeo, audio, teclado, tres botones y rueda.
3. Desconectar con teclas mantenidas: confirmar liberación y que el anfitrión sigue disponible. Reconectar sin otra aprobación.
4. Repetir con escalado 125/150 %, cambios de resolución y bloqueo de puntero en un juego compatible. Comprobar la selección manual de una pantalla secundaria en el flujo manual.
5. Comprobar que otra cuenta no descubre ni controla estos equipos. En el modo Node opcional, comprobar por separado que las conexiones manuales conservan su consentimiento.
6. Cerrar sesión, desactivar la disponibilidad o dejar de compartir: confirmar que se detienen captura y entrada y que la cuenta anterior no puede seguir controlando.
7. Interrumpir las confirmaciones de la conexión: confirmar que la entrada se libera aunque el visitante siga enviando eventos.

Esas pruebas manuales no se consideran completadas por crear un `.exe` desde Linux.

`desktop/account-hosting.test.cjs` comprueba el ancla Google, verificación de sesión, aislamiento entre cuentas/equipos/orígenes, restauración después de una hora, expiración, revocación y respuestas tardías. Esas pruebas sustituyen las respuestas de Google/servicio de forma explícita; no sustituyen la validación física de captura y entrada en Windows.

`desktop/cloud-account.test.cjs` comprueba pruebas HMAC reales con el helper universal compartido, aislamiento de cuenta y clave, desafíos, repetición, contadores, expiración, carreras y persistencia protegida. Para el límite del sistema operativo utiliza un cifrado autenticado de prueba; su resultado no afirma haber ejecutado DPAPI de Windows en Linux.
