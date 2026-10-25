# main, descargas y web del cliente

La web se publica con `deploy-website.yml`, de forma independiente del ejecutable. `publish.yml` verifica y publica las descargas completas. Ambos construyen la rama `gh-pages`; `deploy-static.yml` despliega esa rama mediante las acciones oficiales de Pages y comprueba la página y los archivos públicos. El despliegue y los trabajos de compilación Linux usan el ejecutor estándar Ubuntu 24.04. Las nuevas ejecuciones de publicación cancelan las anteriores que hayan quedado obsoletas. Los cambios exclusivos de documentación o del workflow estático no reconstruyen el ejecutable.

Los flujos de publicación terminan al solicitar la ejecución de `deploy-static.yml` y liberan su runner. El despliegue queda verificado cuando ese workflow estático termina correctamente: después de publicar Pages comprueba HTTP 200, los archivos de la aplicación y los hashes de las descargas disponibles. El éxito del flujo que lo solicita indica que la publicación está encolada.

1. Verifica tipos, pruebas Node, navegador y transmisión real mediante coturn.
2. Compila la aplicación portable en un runner Windows y compila también el auxiliar C# mediante PowerShell, sin inyectar entradas.
3. Crea una release de versión exacta `v<versión>-<commit corto>` con ejecutable, paquete web/servidor, código fuente y SHA-256. No reemplaza los bytes de una publicación existente.
4. Descarga y verifica los artefactos publicados antes de generar `release.json` con enlaces exactos, tamaño, hash y fecha reales.
5. Construye la web con base `/inhouse-games/`, publica `gh-pages` y solicita el despliegue y la comprobación públicos mediante `deploy-static.yml`.

El ejecutable conserva los idiomas español e inglés y usa compresión máxima. Si su tamaño verificado no supera 100 MiB, puede servirse directamente desde `gh-pages`, con su SHA-256; nunca se añade el binario a `main`. Los flujos también publican los paquetes completos en Releases. La fuente completa y los scripts de compilación están en `main`.

GitHub Pages usa **GitHub Actions** como modo de despliegue. Las dos publicaciones lanzan explícitamente `deploy-static.yml` con `--ref main`; ese workflow obtiene los archivos públicos mediante checkout de `gh-pages` y configura el sitio existente para ese modo. La fuente del workflow se mantiene en `main`, sin copiarla a la rama de publicación. Actions necesita permisos de escritura de contenido para la rama de publicación y Releases. El workflow usa su `GITHUB_TOKEN` automático; no se añade un token personal al proyecto.

Configuración avanzada de compilaciones propias:

- `VITE_SIGNALING_URL`: URL HTTPS de un servicio Node/WebSocket propio. Nunca contiene credenciales. La publicación oficial de Pages compila esta variable vacía para usar la conexión automática por cuenta; un usuario puede seleccionar su servicio opcional desde Ajustes.

El script independiente `scripts/check-website.mjs` permite repetir la comprobación manualmente; acepta `PUBLIC_SITE_URL` y comprueba por defecto `https://miguelcoxcaballero.github.io/inhouse-games/`.

GitHub Pages sirve producto, descargas, cliente y broker de login. **No ejecuta el servidor Node/WebSocket ni coturn.** El modo por cuenta utiliza señalización cifrada en el servicio público indicado en [deployment.md](deployment.md), sin activar un alojamiento propio. Node y coturn son opciones avanzadas.

La creación de Releases verifica primero el SHA real de un tag Git inmutable y usa `--verify-tag`, sin pedir al token de Actions que cree una release para un commit ya desplazado de main. Las ejecuciones obsoletas sin tag se omiten. La web conserva las descargas estáticas comprobando los bytes de cada archivo en el commit exacto de `gh-pages`, sin inventar enlaces ni bloquear toda la página.
