# Conectar redes diferentes

La versión 0.3 utiliza por defecto la cuenta Google y un archivo privado de conexión en Drive. **No necesitas activar Render, contratar un servidor ni introducir un código.** En el PC de Murcia abre la aplicación Windows, inicia sesión con Google y mantén activada su disponibilidad. En el portátil entra con la misma cuenta en la web o en Windows y elige el PC en línea.

Al actualizar desde una versión anterior, vuelve a iniciar sesión una vez en Windows 0.3 para crear la autorización nativa protegida con DPAPI. El PC debe seguir encendido, desbloqueado y con la aplicación abierta. No se instala un servicio Windows ni se ofrece desbloqueo remoto.

## Modo habitual por cuenta

El cliente usa el mismo OAuth público y permiso `drive.file` de Notes/Read. Tras comprobar el perfil, obtiene o crea un pequeño archivo **privado**, propiedad de esa cuenta, con una clave aleatoria de conexión. No modifica otros documentos ni comparte el archivo. Guarda una capacidad local de aplicación de hasta 30 días; no amplía ni persiste el token OAuth de Google. [Cuenta y almacenamiento](google-account.md).

La presencia de los equipos y la negociación SDP usan mensajes firmados y cifrados sobre MQTT en `wss://public.cloud.shiftr.io`, mediante TCP443. Shiftr proporciona aquí un servicio público gratuito de pruebas, de un tercero y sin SLA propio de Inhouse. El broker no recibe nombres, perfiles, tokens ni claves en texto claro; puede observar metadatos y tiempos del tráfico.

El vídeo, audio y controles viajan por WebRTC. STUN de Google ayuda a encontrar una ruta directa. **No hay un relay TURN público configurado**, por lo que CGNAT o cortafuegos restrictivos pueden impedir la conexión. La disponibilidad del broker y una ruta WebRTC válida son requisitos de red; iniciar sesión no garantiza que cualquier pareja de operadores permita conectarlos.

La política de red del entorno cloud bloquea comprobar el broker público Shiftr. Las pruebas utilizan un broker MQTT local real y respuestas Google simuladas; WebRTC se comprueba por separado con medios y datos reales. El consentimiento con Google real, los equipos Windows físicos y Murcia–Valencia siguen pendientes. [Alcance de validación](validation.md).

## Elegir un backend propio: opción avanzada

Node, Render y coturn son alternativas para quien quiera operar su señalización o configurar un relay. No forman parte del recorrido habitual por cuenta.

La prioridad de configuración es: dirección guardada en **Ajustes → Tu servicio de conexión**, `VITE_SIGNALING_URL` de la compilación y backend público validado de `service.json`. Sin ninguno, Pages y Windows usan el modo por cuenta. El desarrollo web local y una web autoalojada con Node mantienen su servicio de origen. `public/service.json` incluye inicialmente `{"schema":1,"signalingUrl":null}`: ese valor conserva el modo habitual, no indica que falte activar un servidor.

Para volver al modo por cuenta, elimina la dirección personalizada de Ajustes y utiliza una compilación sin backend predeterminado. Cambiar de modo o de origen exige volver a autenticar la cuenta cuando corresponda; una capacidad privada local nunca se envía a un backend como token Google.

Si seleccionas Node, **ambos equipos deben usar el mismo servidor alcanzable**. Cada proceso mantiene su propio registro de equipos y códigos: dos servidores locales distintos no comparten códigos, aunque el usuario entre con la misma cuenta. Un servidor de señalización tampoco retransmite por sí solo el vídeo ni sustituye TURN.

### Node y HTTPS

En un servidor con Node.js22.12 o posterior:

```sh
npm ci
npm run build
cp .env.example .env
node --env-file=.env server/index.mjs
```

Edita `.env` sin subirlo al repositorio. Configura `ALLOWED_ORIGINS=https://miguelcoxcaballero.github.io` para Pages y añade los demás orígenes HTTPS exactos que uses. Un proxy como Caddy termina HTTPS y reenvía `/signal` con WebSocket y `/api/`. [Caddyfile](../deploy/Caddyfile) es una plantilla; no acredita un despliegue público.

Mantén Node en loopback detrás de tu proxy. `TRUST_PROXY=1` solo es apropiado con un proxy propio que controle `X-Forwarded-For`. Configura la misma URL HTTPS real en los clientes elegidos; una dirección HTTP remota no se admite. El cliente OAuth de Google debe tener autorizado el origen web que ejecuta el login, por lo que Pages puede seguir siendo la web de acceso aunque la señalización esté en otro dominio.

### Render opcional

El [Blueprint incluido](https://github.com/miguelcoxcaballero/inhouse-games/blob/main/render.yaml) prepara Node, HTTPS, WebSocket, Google y STUN. [Desplegar en Render](https://render.com/deploy?repo=https://github.com/miguelcoxcaballero/inhouse-games) requiere una cuenta y autorización del propietario en Render. No se ha activado un servicio por incluir esa plantilla.

Si eliges esta alternativa, espera a que aparezca **Live**, comprueba que `/health` responde `{"ok":true,"version":"0.3.0"}` y configura su URL HTTPS en ambos clientes. El Blueprint solicita el plan Free; revisa sus condiciones antes de crear el servicio. El almacenamiento es efímero y el servicio puede suspenderse o reiniciar: perder `INHOUSE_SESSION_FILE` obliga a volver a entrar con Google, y las conexiones activas deberán restablecerse. Para conservar esas sesiones hace falta almacenamiento persistente compatible. La plantilla no contrata un disco ni incluye TURN.

### Cuenta y secretos en Node

- **Google:** obligatorio. El backend comprueba Google y puede emitir una sesión propia revocable de hasta 30 días. Guarda únicamente hashes y metadatos en el archivo privado `INHOUSE_SESSION_FILE`. `GOOGLE_ALLOWED_EMAILS` permite limitar el uso a cuentas verificadas concretas.
- **`SERVICE_TOKEN`:** clave adicional opcional. Cada cliente la introduce en **Clave del servicio** y la envía como `X-Inhouse-Service-Key`. No sustituye Google ni debe aparecer en enlaces o variables `VITE_`.
- **`TURN_SECRET`:** secreto exclusivo de Node y coturn para emitir credenciales temporales. Nunca se entrega como tal al renderer.
- **Vinculación de dispositivos:** autorización local independiente para los flujos manuales de Node. Las conexiones entre cuentas distintas conservan el consentimiento del anfitrión.

No publiques secretos ni el archivo de sesiones. Cambiar una clave de servicio no revoca una vinculación local; retira también ese permiso desde la aplicación cuando corresponda.

### STUN/TURN propio

Para redes que no permiten una ruta directa, puedes configurar un relay propio o contratado en el modo Node. Usa coturn o un proveedor compatible con [`.env.example`](../.env.example): `TURN_URLS` y `TURN_SECRET`, o `TURN_USERNAME` y `TURN_CREDENTIAL`. Las credenciales se configuran en el servidor, nunca como variables públicas `VITE_`.

Con coturn, `use-auth-secret` y `static-auth-secret` deben corresponder al secreto de Node. Configura realm, direcciones y cuotas de ancho de banda/asignaciones. Para `turns:` necesitas un certificado válido en el puerto declarado; Caddy no convierte TURN automáticamente en TLS.

| Servicio | Puertos habituales, adaptables |
|---|---|
| HTTPS y señalización | TCP443; TCP80 si lo requiere ACME. |
| STUN/TURN | UDP/TCP3478. |
| TURN TLS | TCP5349 u otro puerto configurado. |
| Asignaciones relay | Rango UDP acotado de coturn. |

El backend exige Google antes de entregar credenciales TURN. Puedes restringir cuentas y añadir una clave de servicio para un relay personal. TURN transporta medios cuando es necesario y puede aumentar demora; no garantiza una cifra de latencia o fidelidad.

## Comprobación con los dos equipos

1. Con Windows 0.3, entra con Google y activa la disponibilidad del PC anfitrión.
2. En otro dispositivo con la misma cuenta, comprueba que aparece el PC y conecta sin código ni aceptación en Murcia.
3. Verifica pantalla, audio, teclado y ratón en Windows y en el juego; desconecta y comprueba que el anfitrión sigue disponible.
4. Repite desde otra red real. Consulta ruta, FPS, bitrate y pérdidas; RTT no mide toda la latencia de entrada a pantalla.
5. Desactiva disponibilidad o cierra sesión y comprueba que se detienen captura y control y que se liberan teclas mantenidas.

Si se ha elegido Node/TURN, comprueba además el origen compartido, la autenticación y la ruta relay efectiva. Un `/health` correcto acredita el proceso HTTP, no captura de pantalla, entrada Windows ni transmisión entre redes.

La entrega no incluye un relay mundial, un servicio propio de disponibilidad garantizada ni acceso a los PCs físicos del usuario. Esos límites no convierten el despliegue de un backend en un paso obligatorio del modo por cuenta.
