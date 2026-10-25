#!/usr/bin/env python3
"""Install a verified, unprivileged coturn fixture for the Debian 13 x64 cloud.

No system files, browser policies, TLS checks, package signatures or expected
checksums are changed. Other Linux environments may install their distro's
coturn package and set COTURN_BIN instead.
"""

import argparse
import hashlib
import lzma
import platform
import shutil
import subprocess
import tempfile
import urllib.request
from pathlib import Path


def fetch(url: str, target: Path) -> None:
    with urllib.request.urlopen(url, timeout=60) as response:
        target.write_bytes(response.read())


def fields(stanza: str) -> dict[str, str]:
    result: dict[str, str] = {}
    previous = ""
    for line in stanza.splitlines():
        if line.startswith(" ") and previous:
            result[previous] += "\n" + line
        elif ": " in line:
            previous, value = line.split(": ", 1)
            result[previous] = value
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", type=Path, default=Path(__file__).resolve().parents[2] / ".tools" / "coturn")
    args = parser.parse_args()
    if platform.system() != "Linux" or platform.machine() not in {"x86_64", "amd64"}:
        raise SystemExit("This bootstrap supports Debian-compatible Linux x64. Install coturn separately and set COTURN_BIN.")
    keyring = Path("/usr/share/keyrings/debian-archive-keyring.pgp")
    if not keyring.exists() or not shutil.which("sqv") or not shutil.which("dpkg-deb"):
        raise SystemExit("The Debian archive keyring, sqv and dpkg-deb are required. No unsigned fallback is used.")
    prefix = args.prefix.resolve()
    wanted = {"coturn", "libhiredis1.1.0", "libevent-extra-2.1-7t64", "libevent-openssl-2.1-7t64"}
    base = "https://deb.debian.org/debian/"
    with tempfile.TemporaryDirectory(prefix="inhouse-coturn-verified-") as directory:
        temporary = Path(directory)
        fetch(base + "dists/trixie/InRelease", temporary / "InRelease")
        subprocess.run([
            "sqv", "--keyring=" + str(keyring), "--output=" + str(temporary / "Release"),
            "--cleartext", str(temporary / "InRelease"),
        ], check=True)
        release = (temporary / "Release").read_text()
        sha_section = release.split("SHA256:\n", 1)[1]
        index_path = "main/binary-amd64/Packages.xz"
        record = next(line.split() for line in sha_section.splitlines() if line.strip().endswith(index_path))
        fetch(base + "dists/trixie/" + index_path, temporary / "Packages.xz")
        compressed = (temporary / "Packages.xz").read_bytes()
        if len(compressed) != int(record[1]) or hashlib.sha256(compressed).hexdigest() != record[0]:
            raise SystemExit("Debian package-index integrity verification failed.")
        selected = {}
        for stanza in lzma.decompress(compressed).decode().split("\n\n"):
            package = fields(stanza)
            if package.get("Package") in wanted:
                selected[package["Package"]] = package
        if set(selected) != wanted:
            raise SystemExit("The signed Debian index does not contain every required fixture package.")
        prefix.mkdir(parents=True, exist_ok=True)
        for name in sorted(wanted):
            package = selected[name]
            archive = temporary / (name + ".deb")
            fetch(base + package["Filename"], archive)
            if hashlib.sha256(archive.read_bytes()).hexdigest() != package["SHA256"]:
                raise SystemExit("Package integrity verification failed: " + name)
            subprocess.run(["dpkg-deb", "-x", str(archive), str(prefix)], check=True)
            print("Verified and extracted", name, package["Version"])
    subprocess.run([
        "/lib64/ld-linux-x86-64.so.2", "--library-path", str(prefix / "usr/lib/x86_64-linux-gnu"),
        str(prefix / "usr/bin/turnserver"), "--version",
    ], check=True)
    print("Test coturn ready at", prefix)


if __name__ == "__main__":
    main()
