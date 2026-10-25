# Conectar redes diferentes

El `.exe` y la web necesitan el mismo servidor de señalización alcanzable. El vídeo viaja por WebRTC entre equipos o mediante TURN; no lo retransmite el servidor HTTP. Para Murcia–Valencia hacen falta un dominio/servidor y una ruta ICE adecuada a ambos operadores.

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
