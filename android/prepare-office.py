#!/usr/bin/env python3
"""Prepare pinned LibreOffice runtime assets for one Android CPU. No runtime downloads."""
import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

packages = {
    'arm64-v8a': (135, 'e921bfb14170824572eb1e33643538803681226427948c245084f5e6356c3775'),
    'armeabi-v7a': (134, '010ce43e7b6e9bcbe1e4fc6d3096d4d93f35f83338594800fae748d07cb3757e'),
    'x86_64': (133, '4c1162398ce8d96ff9dad91165945892f7f57428f3a59a08085d9dd39c125469'),
    'x86': (132, '4a41ca371599a23501be7ac278ae7c74f2384e20448fa7cdc4046d930610d653'),
}
parser = argparse.ArgumentParser()
parser.add_argument('abi', choices=packages)
parser.add_argument('output', type=Path)
parser.add_argument('cache', type=Path)
args = parser.parse_args()
code, expected = packages[args.abi]
args.cache.mkdir(parents=True, exist_ok=True)
apk = args.cache / (expected + '.apk')
def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()
if not apk.exists() or digest(apk) != expected:
    with tempfile.NamedTemporaryFile(dir=args.cache) as handle:
        for base in ['https://f-droid.org/repo/', 'https://mirrors.tuna.tsinghua.edu.cn/fdroid/repo/']:
            url = base + 'org.documentfoundation.libreoffice_' + str(code) + '.apk'
            result = subprocess.run(['curl', '-fLsS', '--connect-timeout', '12', '-o', handle.name, url])
            if result.returncode == 0 and digest(Path(handle.name)) == expected:
                shutil.copyfile(handle.name, apk)
                break
        else:
            raise SystemExit('Could not obtain verified Android LibreOfficeKit ' + args.abi)
assets = args.output
assets.mkdir(parents=True, exist_ok=True)
# Keep the original, pinned upstream archive embedded; Android installs the same
# Java APK on any ABI, so even a legacy updater can transition to the right CPU.
shutil.copyfile(apk, assets / 'office.lopack')
(assets / 'office-abi').write_text(args.abi)
with zipfile.ZipFile(apk) as archive:
    for name in archive.namelist():
        if name.startswith(('assets/program/', 'assets/share/', 'assets/unpack/')) and not name.endswith('/'):
            dest = assets / name[len('assets/'):]
            dest.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(name) as src, dest.open('wb') as out:
                shutil.copyfileobj(src, out)
