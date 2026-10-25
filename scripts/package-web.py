#!/usr/bin/env python3
"""Package a built web client and its Node signaling service, without secrets."""
from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'package.json').read_text())
lock = json.loads((root / 'package-lock.json').read_text())
if not (root / 'dist/index.html').is_file():
    raise SystemExit('Run npm run build first.')
runtime = {
    'name': manifest['name'] + '-web', 'version': manifest['version'],
    'private': True, 'type': 'module', 'license': manifest['license'],
    'engines': manifest['engines'], 'scripts': {'start': 'node server/index.mjs'},
    'dependencies': {'ws': manifest['dependencies']['ws']},
}
runtime_lock = {
    'name': runtime['name'], 'version': runtime['version'], 'lockfileVersion': 3,
    'requires': True, 'packages': {
        '': {key: runtime[key] for key in ['name', 'version', 'license', 'engines', 'dependencies']},
        'node_modules/ws': lock['packages']['node_modules/ws'],
    },
}
output = root / 'artifacts/Inhouse-Link-Web.zip'
output.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    archive.writestr('package.json', json.dumps(runtime, indent=2) + '\n')
    archive.writestr('package-lock.json', json.dumps(runtime_lock, indent=2) + '\n')
    archive.writestr('README.txt', 'inhouse link — web y servicio\n\nRequiere Node.js22.12+. Ejecuta npm ci --omit=dev y npm start.\nPara cargar .env: node --env-file=.env server/index.mjs\nConsulta docs/deployment.md para HTTPS y STUN/TURN.\nEl ejecutable Windows se entrega por separado.\n')
    for directory in ['dist', 'server', 'deploy']:
        for item in sorted((root / directory).rglob('*')):
            if not item.is_file() or 'downloads' in item.relative_to(root).parts:
                continue
            archive.write(item, item.relative_to(root))
    for name in ['.env.example', 'docs/deployment.md', 'docs/comparison.md']:
        archive.write(root / name, name)
checksum = hashlib.sha256(output.read_bytes()).hexdigest()
output.with_suffix('.zip.sha256').write_text(f'{checksum}  {output.name}\n')
print(f'Web package prepared: {output.name} ({output.stat().st_size:,} bytes).')
