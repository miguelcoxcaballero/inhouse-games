# Conectar redes diferentes

El `.exe` y la web necesitan el mismo servidor de señalización alcanzable. El vídeo viaja por WebRTC entre equipos o mediante TURN; no lo retransmite el servidor HTTP. Para Murcia–Valencia hacen falta un dominio/servidor y una ruta ICE adecuada a ambos operadores.

## Sin VPS: servicio gestionado en Render

El [Blueprint incluido](https://github.com/miguelcoxcaballero/inhouse-games/blob/main/render.yaml) prepara un servicio Node con HTTPS, WebSocket, autenticación Google obligatoria y STUN público de Google. Puedes desplegarlo en tu propia cuenta de Render:

[Desplegar el servicio de Inhouse Link en Render](https://render.com/deploy?repo=https://github.com/miguelcoxcaballero/inhouse-games)

1. Inicia sesión o crea una cuenta en Render, conecta el repositorio y revisa el Blueprint. La configuración solicita el plan **Free**; comprueba sus condiciones y disponibilidad antes de crear el servicio. Este botón no implica que ya exista un despliegue.
2. Espera a que el servicio aparezca como **Live** y copia su URL HTTPS real de Render. Abre su ruta `/health`: debe devolver `{"ok":true,"version":"0.2.0"}`.
3. Abre el [cliente de GitHub Pages](https://miguelcoxcaballero.github.io/inhouse-games/#/client), inicia sesión con Google y entra en **Ajustes → Tu servicio de conexión**. Pega la URL HTTPS copiada, deja vacía **Clave del servicio** y guarda. Vuelve a iniciar sesión si se solicita al cambiar de servicio.
4. Configura esa misma URL en la aplicación Windows del PC anfitrión y en cualquier otro cliente Windows. El acceso Google conserva el cliente OAuth de Notes y Read. Usa Pages como cliente web: el dominio nuevo de Render no se añade automáticamente a los orígenes autorizados de Google.
5. Comprueba una conexión entre redes siguiendo los pasos de validación de abajo. Un `/health` correcto comprueba el servicio, no la transmisión de pantalla.

Render proporciona `PORT`; el servidor escucha en `0.0.0.0` detrás de su proxy HTTPS. La compilación instala las dependencias de desarrollo necesarias para Vite y omite la descarga del binario de Electron, que este servicio no ejecuta. Los orígenes de Pages y los clientes nativos locales están permitidos por la configuración existente; no se desactiva la autenticación Google ni se exige una clave adicional.

El plan gratuito puede suspender el servicio cuando está inactivo, causar un arranque lento o reiniciar la instancia. Su almacenamiento es efímero: los reinicios o despliegues pueden borrar las sesiones de cuenta guardadas y los códigos de conexión; será necesario iniciar sesión y compartir de nuevo. Para conservar las sesiones necesitas un almacenamiento persistente compatible y ajustar `INHOUSE_SESSION_FILE`; este Blueprint no contrata un disco ni un plan de pago.

STUN ayuda a encontrar una ruta directa, pero **no garantiza conexión bajo CGNAT ni en cualquier red**. El Blueprint no incluye TURN ni inventa credenciales. Si dispones de un relay propio o contratado, añade en el panel privado de Render `TURN_URLS` y `TURN_SECRET`, o `TURN_USERNAME` y `TURN_CREDENTIAL`, según la sección STUN/TURN. No publiques esos secretos como variables `VITE_`. Render aloja la señalización; su servicio web no sustituye un relay TURN.

## Web y señalización

En un servidor con Node.js22.12 o posterior:

```sh
npm ci
npm run build
cp .env.example .env
node --env-file=.env server/index.mjs
```

Edita `.env` en el servidor sin subirlo al repositorio. Configura `ALLOWED_ORIGINS=https://miguelcoxcaballero.github.io` para el cliente publicado en GitHub Pages y añade los otros orígenes HTTPS exactos que uses. Un proxy como Caddy termina HTTPS y reenvía `/signal` con soporte WebSocket, los archivos y `/api/`. [Caddyfile](../deploy/Caddyfile) es una plantilla con dominio configurable; no un despliegue ya realizado.

Construye el ejecutable con `npm run build:windows`, o copia el artefacto verificado y su SHA-256 a `dist/downloads/`. `npm run build` también copia lo presente en `public/downloads/`.

Mantén Node en loopback detrás del proxy. `TRUST_PROXY=1` solo es apropiado con un proxy local propio que controle `X-Forwarded-For`.

## Autenticación

Son materiales distintos:

- **Cuenta Google:** obligatoria. Se usa el cliente OAuth compartido de Notes y Read. El servidor comprueba Google y crea sesiones revocables de hasta 30 días; conserva su archivo privado `INHOUSE_SESSION_FILE` entre reinicios y no lo publiques. `GOOGLE_ALLOWED_EMAILS` permite limitar un despliegue personal a las cuentas que elijas.
- **SERVICE_TOKEN:** clave adicional opcional. Se introduce en **Clave del servicio**, sin incluirla en enlaces ni en el bundle público. Las peticiones la envían mediante `X-Inhouse-Service-Key`, separada de la autenticación de cuenta.
- **TURN_SECRET:** secreto entre Node y coturn, solo en el servidor. Los clientes reciben credenciales HMAC temporales.
- **Vinculación:** identidad privada del anfitrión y credenciales por portátil, locales e intercambiadas después de aprobar mediante WebRTC cifrado.

Genera valores aleatorios largos con tu gestor de secretos o herramienta criptográfica local. No los pegues en chat ni los subas al repositorio. Rotar SERVICE_TOKEN no revoca por sí mismo una vinculación; revócala también en la app si corresponde.

## STUN/TURN

STUN ayuda a descubrir una ruta directa. TURN permite relay si CGNAT o un cortafuegos impiden esa ruta. Para viajes conviene disponer de TURN UDP y también TCP/TLS. El cliente muestra la ruta seleccionada; un relay puede añadir demora.

Usa coturn o un proveedor compatible con [`.env.example`](../.env.example). Con coturn, `use-auth-secret` y `static-auth-secret` deben corresponder a `TURN_SECRET`; configura realm y direcciones de escucha/publicación según tu servidor. Para `turns:`, coturn necesita un certificado válido en el puerto declarado: Caddy no convierte automáticamente TURN en TLS.

| Servicio | Puertos habituales, adaptables |
|---|---|
| Web/señalización HTTPS | TCP443; TCP80 si lo necesita ACME. |
| STUN/TURN | UDP/TCP3478. |
| TURN TLS | TCP5349 u otro puerto configurado. |
| Asignaciones relay | Rango UDP acotado de coturn. |

Configura cuotas de asignaciones/ancho de banda de coturn. El backend exige una cuenta Google verificada al ofrecer TURN; los visitantes anónimos no obtienen credenciales. Puedes añadir la clave de servicio y restringir `GOOGLE_ALLOWED_EMAILS` para un uso personal. La cuenta no concede control del PC: siguen vigentes aprobación y vinculación.

No configures destinos TURN inexistentes. `/health` correcto no demuestra que los equipos puedan transmitir vídeo. Para esa comprobación:

1. Abre la web HTTPS y configura la misma URL/clave en el PC de Murcia.
2. Realiza la primera vinculación junto al PC y comprueba pantalla, audio y entrada en el juego.
3. Cambia el portátil a otra conexión real y reconecta desde el equipo vinculado.
4. Consulta ruta, FPS, bitrate y pérdidas; exporta el diagnóstico. RTT no es latencia completa de entrada a pantalla.
5. Revoca confianza, comprueba que vuelve a exigir aprobación y que al cerrar no quedan teclas pulsadas.

La entrega incluye programa y configuración. No incluye dominio, relay mundial, certificados de producción ni acceso al PC físico; la validación Murcia–Valencia queda pendiente de ese despliegue y ambos equipos.
