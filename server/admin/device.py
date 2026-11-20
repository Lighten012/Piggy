#!/usr/bin/env python3
"""Root operator CLI. Only invite hashes and labels are stored on the server."""
import argparse
import hashlib
import os
from pathlib import Path
import secrets

parser = argparse.ArgumentParser()
commands = parser.add_subparsers(dest="command", required=True)
commands.add_parser("issue").add_argument("label")
commands.add_parser("list")
commands.add_parser("revoke").add_argument("id")
args = parser.parse_args()
directory = Path("/lighten012/projects/Piggy/devices")
if args.command == "issue":
    if not args.label.isprintable() or len(args.label) > 80:
        parser.error("invalid label")
    directory.mkdir(mode=0o755, exist_ok=True)
    code = secrets.token_hex(32)
    record = directory / hashlib.sha256(code.encode()).hexdigest()
    with record.open("x") as f:
        f.write(args.label + "\n")
        os.fchmod(f.fileno(), 0o644)
    print(code)
elif args.command == "list":
    for record in sorted(directory.iterdir()):
        print(record.name, record.read_text().strip())
else:
    if len(args.id) != 64 or any(c not in "0123456789abcdef" for c in args.id):
        parser.error("invalid device id")
    (directory / args.id).unlink()
