# main, descargas y web del cliente

La web se publica con `deploy-website.yml`, de forma independiente del ejecutable. `publish.yml` verifica y publica las descargas completas. Ambos construyen la rama `gh-pages`; `deploy-static.yml` despliega esa rama mediante las acciones oficiales de Pages y comprueba la página y los archivos públicos. El despliegue estático usa el contenedor ligero `ubuntu-slim`; los trabajos de compilación Linux usan Ubuntu 24.04.

1. Verifica tipos, pruebas Node, navegador y transmisión real mediante coturn.
2. Compila la aplicación portable en un runner Windows y compila también el auxiliar C# mediante PowerShell, sin inyectar entradas.
3. Crea una release de versión exacta `v<versión>-<commit corto>` con ejecutable, paquete web/servidor, código fuente y SHA-256. No reemplaza los bytes de una publicación existente.
4. Descarga y verifica los artefactos publicados antes de generar `release.json` con enlaces exactos, tamaño, hash y fecha reales.
5. Construye la web con base `/inhouse-games/`, publica `gh-pages` y comprueba la web y el manifiesto públicos.

El ejecutable conserva los idiomas español e inglés y usa compresión máxima. Si su tamaño verificado no supera 100 MiB, puede servirse directamente desde `gh-pages`, con su SHA-256; nunca se añade el binario a `main`. Los flujos también publican los paquetes completos en Releases. La fuente completa y los scripts de compilación están en `main`.

GitHub Pages usa **GitHub Actions** como modo de despliegue. El flujo estático configura el sitio existente para ese modo; su código se ejecuta desde gh-pages. Actions necesita permisos de escritura de contenido para la rama de publicación y Releases. El workflow usa su `GITHUB_TOKEN` automático; no se añade un token personal al proyecto.

Variables opcionales del repositorio:

- `VITE_SIGNALING_URL`: URL HTTPS del servicio Node/WebSocket desplegado. Si falta, se configura desde el cliente. Nunca contiene credenciales.
- `INHOUSE_LINK_SITE_URL`: URL pública distinta para comprobar el despliegue; por defecto se comprueba `https://miguelcoxcaballero.github.io/inhouse-games/`.

GitHub Pages sirve producto, descargas, cliente y broker de login. **No ejecuta el servidor Node/WebSocket ni coturn.** El servicio de conexión se despliega aparte con los pasos de [deployment.md](deployment.md).

La creación de Releases verifica primero el SHA real de un tag Git inmutable y usa `--verify-tag`, sin pedir al token de Actions que cree una release para un commit ya desplazado de main. Las ejecuciones obsoletas sin tag se omiten. La web conserva las descargas estáticas comprobando los bytes de cada archivo en el commit exacto de `gh-pages`, sin inventar enlaces ni bloquear toda la página.
