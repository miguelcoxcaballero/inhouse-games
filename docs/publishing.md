# main, descargas y web del cliente

El workflow `.github/workflows/publish.yml` se ejecuta al subir a `main` o al iniciarlo manualmente desde Actions. Usa el mismo patrón de rama `gh-pages` que los proyectos Inhouse Notes y Read.

1. Verifica tipos, pruebas Node, navegador y transmisión real mediante coturn.
2. Compila la aplicación portable en un runner Windows y compila también el auxiliar C# mediante PowerShell, sin inyectar entradas.
3. Crea una release de versión exacta `v<versión>-<commit corto>` con ejecutable, paquete web/servidor, código fuente y SHA-256. No reemplaza los bytes de una publicación existente.
4. Descarga y verifica los artefactos publicados antes de generar `release.json` con enlaces exactos, tamaño, hash y fecha reales.
5. Construye la web con base `/inhouse-games/`, publica `gh-pages` y comprueba la web y el manifiesto públicos.

El ejecutable supera el límite de un blob Git; se publica como artefacto de Releases en lugar de incluirlo en el historial de `main`. La fuente completa y los scripts de compilación sí están en `main`.

GitHub Pages debe estar habilitado para servir **Deploy from a branch → gh-pages → /(root)**. Actions necesita permisos de escritura de contenido para la rama de publicación y Releases. El workflow usa su `GITHUB_TOKEN` automático; no se añade un token personal al proyecto.

Variables opcionales del repositorio:

- `VITE_SIGNALING_URL`: URL HTTPS del servicio Node/WebSocket desplegado. Si falta, se configura desde el cliente. Nunca contiene credenciales.
- `INHOUSE_LINK_SITE_URL`: URL pública distinta para comprobar el despliegue; por defecto se comprueba `https://miguelcoxcaballero.github.io/inhouse-games/`.

GitHub Pages sirve producto, descargas, cliente y broker de login. **No ejecuta el servidor Node/WebSocket ni coturn.** El servicio de conexión se despliega aparte con los pasos de [deployment.md](deployment.md).
