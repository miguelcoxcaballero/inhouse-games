# La cuenta de Inhouse Notes y Read

Link utiliza el mismo **Google Identity Services OAuth2** y el mismo cliente web público que Notes y Read: `435784295430-cmug30o42f1vu4ijgor9sjb0ro4oo37o.apps.googleusercontent.com`. Es un identificador público, no una credencial secreta.

El cliente carga `https://accounts.google.com/gsi/client`, crea `google.accounts.oauth2.initTokenClient` y solicita acceso directamente desde el clic. Como Read, pide `https://www.googleapis.com/auth/drive.file` y obtiene el perfil de `https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,photoLink,permissionId)`. Link no lee ni escribe documentos de Drive y no añade el permiso Calendar de Notes. Si la misma cuenta ya concedió a Notes el permiso completo de Drive, ese permiso existente también se reconoce como válido; Link sigue solicitando únicamente drive.file.

Esto reutiliza el proveedor y flujo de cuenta, no una sesión mágica compartida entre aplicaciones: cada una conserva sus propias claves. Link usa `inhouse.link.google-session.v1`. Un avatar o email guardados no son prueba de autenticación.

## Validación y duración

El servidor valida el acceso con Google mediante `POST https://oauth2.googleapis.com/tokeninfo`, Bearer en cabecera, y comprueba audiencia, permiso y caducidad. El uso de POST con la credencial en cabecera coincide con el cliente oficial Google Auth de Node. El perfil se vuelve a obtener de Google; no se confía en un email enviado por el cliente.

Tras validar Google, `POST /api/auth/session` crea una sesión propia de aplicación de hasta 30 días. El servidor guarda **solo el hash SHA-256** del token opaco y los metadatos de cuenta/caducidad en un archivo privado, con escritura atómica. No guarda el access token de Google. Reiniciar el servidor conserva las sesiones si se conserva ese archivo; se configura con `INHOUSE_SESSION_FILE`.

El cliente vincula esa sesión al origen exacto del servicio. No la envía a otro servidor si cambia la configuración. El cierre de sesión revoca su sesión del servicio; una sesión de aplicación no se renueva indefinidamente por volver a presentarla. La cuenta Google autentica a la persona, pero el anfitrión sigue aprobando el acceso o verificando una vinculación previa.

## Windows

Google se abre en el navegador habitual, no en Electron. El broker público `#/desktop-auth` utiliza el mismo popup GIS y devuelve a `127.0.0.1:48715` una respuesta cifrada para una clave efímera de esa aplicación: ECDH P-256, HKDF-SHA256 y AES-GCM. Se vincula al nonce, caduca en cinco minutos y se consume una vez. Los tokens no aparecen en texto claro en URLs.

El broker mantiene el token Google solo en memoria para la transferencia. El cliente Windows valida ese acceso y lo intercambia con el servicio configurado por la sesión de aplicación duradera; no se reutilizan los clientes OAuth Android de Notes/Read.

## Origen de publicación

La ruta de GitHub Pages es `https://miguelcoxcaballero.github.io/inhouse-games/`. Comparte el origen `https://miguelcoxcaballero.github.io` utilizado por Read. Google autoriza orígenes, no rutas. El propietario debe mantener ese origen autorizado en su configuración OAuth; un dominio nuevo o un origen de desarrollo distinto requiere su propia autorización.

El servidor permite el popup mediante COOP `same-origin-allow-popups` y una CSP limitada a los destinos oficiales de Google necesarios. El backend propio de señalización necesita acceso a `oauth2.googleapis.com` y `www.googleapis.com`.

Las pruebas automatizadas sustituyen las respuestas del proveedor de identidad y validan las fronteras criptográficas y de sesión. No equivalen a haber iniciado sesión con una cuenta Google real del usuario.
