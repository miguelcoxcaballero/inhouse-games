# La cuenta de Inhouse Notes y Read

Link utiliza **Google Identity Services OAuth2** y el mismo cliente web público que Notes y Read: `435784295430-cmug30o42f1vu4ijgor9sjb0ro4oo37o.apps.googleusercontent.com`. Es un identificador público, no un secreto. El modo habitual de la versión 0.3 solo requiere esa cuenta; no hay que activar un servidor ni introducir códigos de conexión.

El cliente carga `https://accounts.google.com/gsi/client`, crea `google.accounts.oauth2.initTokenClient` y solicita acceso directamente desde el clic. Como Read, pide únicamente `https://www.googleapis.com/auth/drive.file`. Obtiene el perfil de `https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,photoLink,permissionId)` y utiliza `permissionId` como identidad estable. Si Notes ya recibió el permiso completo de Drive para este mismo cliente, se acepta ese permiso existente; Link sigue solicitando solo `drive.file`, sin añadir Calendar.

Las aplicaciones comparten proveedor y cliente OAuth, pero conservan sus propias sesiones. Un avatar o un email recordados no acreditan una cuenta.

## Archivo privado de conexión

Tras comprobar el perfil con Google, Link busca un archivo propio identificado mediante `appProperties['inhouse.link.realm']='1'`. Si no existe, crea `.inhouse-link-realm.v1.json`: un pequeño JSON con versión, identidad de cuenta y una clave aleatoria de 256 bits. Comprueba que pertenece al usuario, que no está compartido y que su contenido corresponde a esa cuenta. No cambia sus permisos de acceso ni modifica otros documentos de Drive.

Los equipos que entran con la misma cuenta recuperan esa misma clave privada. Drive se utiliza para guardar la clave; el vídeo, el audio, las pulsaciones y la señalización de cada conexión no se guardan allí. Cerrar sesión elimina la copia local y conserva el archivo privado para los demás equipos.

## Sesión privada de hasta 30 días

El acceso OAuth de Google conserva su caducidad original. Link no lo convierte en un token Google de 30 días, no solicita un refresh token y no guarda ese acceso OAuth en la sesión del modo habitual.

Después de obtener el archivo privado, crea una **capacidad local de aplicación** independiente, con token aleatorio `ild_…`, perfil, clave de cuenta y caducidad máxima de 30 días. La caché privada es `inhouse.link.cloud-account.v1`; su registro de sesión correspondiente usa `inhouse.link.google-session.v1` y `kind:'cloud'`. Restaurar una sesión exige que coincidan capacidad, perfil y caducidad entre ambos registros. Un perfil aislado no basta, y restaurar la capacidad no amplía su duración.

En el navegador esta capacidad pertenece al almacenamiento local de ese origen. Borrar los datos o agotar la sesión obliga a volver a entrar con Google. Cerrar sesión borra la copia de este cliente, sin revocar sesiones de otras aplicaciones ni eliminar el archivo de Drive.

## Equipos y transporte

Los PCs Windows con disponibilidad activada aparecen en la cuenta. La misma cuenta puede conectar sin código ni aprobación por conexión; el anfitrión debe permanecer encendido, desbloqueado y con la aplicación en ejecución. Desactivar su disponibilidad, cerrar sesión o salir de la app retira ese acceso.

La presencia y las ofertas/respuestas SDP se intercambian por MQTT sobre `wss://public.cloud.shiftr.io` (TCP443). Cada mensaje se firma con una identidad P-256 y se cifra con AES-GCM; el canal de cuenta se deriva de su clave privada. Los nombres, perfiles, tokens y claves no llegan en texto claro al broker. El broker sí puede observar las conexiones, temas opacos, tamaños y tiempos del tráfico.

Shiftr es aquí un servicio público gratuito de pruebas de un tercero, sin garantía de disponibilidad propia de Inhouse. No requiere que el usuario active un backend. WebRTC transporta los medios y la entrada; STUN de Google intenta encontrar una ruta directa. El modo por cuenta no incluye un TURN público para redes que impidan esa ruta.

## Windows y actualización a 0.3

Google se abre en el navegador habitual, no en Electron. El broker web `#/desktop-auth` mantiene el token Google solo en memoria y devuelve a `127.0.0.1:48715` un handoff cifrado para la aplicación: ECDH P-256, HKDF-SHA256 y AES-GCM, ligado a un estado aleatorio, válido durante cinco minutos y de un solo uso. No se incluyen tokens en texto claro en URLs. No se reutilizan los clientes OAuth Android de Notes/Read.

El proceso principal verifica por su cuenta audiencia, permiso, caducidad y perfil con Google, y obtiene él mismo el archivo privado de Drive. Guarda su autorización de hasta 30 días mediante `safeStorage` de Electron —DPAPI en Windows—, sin persistir el token Google. Si no dispone de almacenamiento protegido, mantiene esa autorización solo en memoria. La copia del renderer nunca reemplaza esta autorización nativa: al restaurar, debe confirmarla el proceso principal.

**Al actualizar desde una versión anterior, abre Windows 0.3 y vuelve a iniciar sesión con Google una vez.** Esto crea el ancla nativa protegida necesaria para quedar disponible. Una caché de perfil anterior no la sustituye. El permiso de entrada se comprueba además con desafíos HMAC de corta duración y contadores contra repetición; no depende de una bandera enviada por JavaScript. [Detalles del escritorio](../desktop/README.md).

## Servidor propio opcional

Una dirección de servicio elegida explícitamente, `VITE_SIGNALING_URL` o un backend publicado en `service.json` seleccionan el modo Node. En desarrollo web local y en una web autoalojada con Node también se conserva ese modo. Pages y Windows, sin backend seleccionado, utilizan el archivo privado de cuenta.

Node verifica Google mediante `POST https://oauth2.googleapis.com/tokeninfo` con Bearer en cabecera, comprueba audiencia, permiso y caducidad y obtiene el perfil de Drive. Después, `POST /api/auth/session` puede crear una sesión opaca `ihl_…` de hasta 30 días. El servidor persiste solo el hash SHA-256 y metadatos de perfil/caducidad en `INHOUSE_SESSION_FILE`; no guarda el token Google. La sesión se vincula al origen exacto del servidor, no se renueva indefinidamente y se revoca mediante `DELETE /api/auth/session` al cerrar sesión.

Una capacidad local `ild_…` nunca se envía a Node como si fuera Google. Cambiar del modo por cuenta a un servidor propio requiere un nuevo acceso Google. Las invitaciones a otra cuenta, cuando se usan en Node, siguen necesitando consentimiento del anfitrión. [Configuración avanzada](deployment.md).

## Publicación y validación

La web es `https://miguelcoxcaballero.github.io/inhouse-games/` y comparte el origen usado por Read. Google autoriza orígenes, no rutas; el propietario debe mantener ese origen permitido en el cliente OAuth. Un dominio distinto necesita su propia autorización. El servidor del escritorio permite el popup con COOP `same-origin-allow-popups` y restringe los destinos necesarios mediante CSP.

Los tests de cuenta sustituyen las respuestas de Google y ejercitan el archivo privado, la caducidad y las carreras de cierre de sesión. MQTT se prueba con un broker local real; WebRTC se valida por separado con medios y canales de datos reales. La política de red del entorno cloud bloquea la comprobación del broker público. Siguen pendientes el consentimiento Google real, DPAPI/captura/control en Windows físico y el enlace Murcia–Valencia; las pruebas locales no acreditan esos resultados. [Evidencia de validación](validation.md).
