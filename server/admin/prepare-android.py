#!/usr/bin/env python3
"""Prepare a signed APK for the Piggy gateway's publish-android command."""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("apk", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--build-tools", required=True, type=Path)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
artifact = args.output / "Piggy.apk"
shutil.copyfile(args.apk, artifact)
def run(tool, *params):
    return subprocess.check_output([str(args.build_tools / tool), *params, str(artifact)], text=True)
signers = re.findall(r"^Signer #\d+ certificate SHA-256 digest: ([0-9a-f]{64})$", run("apksigner", "verify", "--print-certs"), re.M)
badges = run("aapt", "dump", "badging")
pkg = re.search(r"^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", badges, re.M)
sdk = re.search(r"^sdkVersion:'(\d+)'", badges, re.M)
if len(signers) != 1 or not pkg or pkg[1] != "dev.pichat" or not sdk:
    parser.error("expected a signed Piggy APK with a valid version and minSdk")
meta = dict(packageName=pkg[1], versionCode=int(pkg[2]), versionName=pkg[3], minSdk=int(sdk[1]),
            size=artifact.stat().st_size, sha256=hashlib.sha256(artifact.read_bytes()).hexdigest(),
            signerSha256=signers[0])
(args.output / "latest.json").write_text(json.dumps(meta) + "\n")
print(f"Prepared {pkg[1]} {pkg[3]} ({pkg[2]})")
