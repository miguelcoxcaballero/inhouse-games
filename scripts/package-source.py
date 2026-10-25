#!/usr/bin/env python3
"""Create a reproducible source archive without runtime secrets or binaries."""
import argparse
import hashlib
import os
import time
import zipfile
from pathlib import Path

SOURCE_DIRECTORIES = ('.github', 'src', 'desktop', 'server', 'scripts', 'tests', 'docs', 'deploy', 'public', 'vendor')
IGNORED_PARTS = {'.git', 'node_modules', 'dist', 'artifacts', 'downloads', '__pycache__', '.pytest_cache', '.cache', 'test-results', 'playwright-report'}
IGNORED_SUFFIXES = {'.exe', '.apk', '.zip', '.blockmap', '.log', '.pyc'}
ROOT_FILES = ('README.md', 'AGENTS.md', 'IMPLEMENTATION.md', '.gitignore', '.gitattributes', '.env.example', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'playwright.config.ts', 'render.yaml')


def package(root: Path, output: Path) -> int:
    root = root.resolve()
    if not (root / 'package.json').is_file():
        raise ValueError('The source root must contain package.json.')
    files = set()
    for name in SOURCE_DIRECTORIES:
        directory = root / name
        if directory.is_symlink():
            raise ValueError('Source directories must not be symbolic links: ' + name)
        if not directory.is_dir():
            continue
        for item in directory.rglob('*'):
            relative = item.relative_to(root)
            if any(part in IGNORED_PARTS for part in relative.parts):
                continue
            if item.name.startswith('.env') and item.name != '.env.example':
                continue
            if item.suffix.lower() in IGNORED_SUFFIXES:
                continue
            if item.is_symlink():
                raise ValueError('Source files must not be symbolic links: ' + str(relative))
            if item.is_file():
                files.add(item)
    for name in ROOT_FILES:
        item = root / name
        if item.is_symlink():
            raise ValueError('Root files must not be symbolic links: ' + name)
        if item.is_file():
            files.add(item)
    files.update(item for item in root.glob('*.html') if item.is_file() and not item.is_symlink())
    # One stable timestamp makes the same source inputs produce the same bytes.
    epoch = min(4354819198, max(315532800, int(os.environ.get('SOURCE_DATE_EPOCH', '315532800'))))
    timestamp = time.gmtime(epoch)[:6]
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for item in sorted(files):
            metadata = zipfile.ZipInfo(item.relative_to(root).as_posix(), timestamp)
            metadata.compress_type = zipfile.ZIP_DEFLATED
            metadata.create_system = 3
            metadata.external_attr = 0o100644 << 16
            archive.writestr(metadata, item.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(output.suffix + '.sha256').write_text(f'{digest}  {output.name}\n')
    return len(files)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--output', type=Path)
    options = parser.parse_args()
    output = options.output or options.root / 'artifacts/Inhouse-Link-Source.zip'
    count = package(options.root, output)
    print(f'Source package prepared: {output.name} ({count} files).')


if __name__ == '__main__':
    main()
