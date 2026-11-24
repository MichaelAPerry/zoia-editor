"""Command-line interface for the ZOIA patch codec."""

import argparse
import json
from pathlib import Path

from . import decode, encode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("decode", "encode"))
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    try:
        if args.operation == "decode":
            patch = decode(args.input.read_bytes())
            args.output.write_text(json.dumps(patch, indent=2) + "\n", encoding="utf-8")
        else:
            patch = json.loads(args.input.read_text(encoding="utf-8"))
            if not isinstance(patch, dict):
                raise ValueError("Patch JSON must be an object")
            args.output.write_bytes(encode(patch))
    except (OSError, KeyError, TypeError, ValueError) as error:
        parser.exit(1, f"zoiacodec: {error}\n")


if __name__ == "__main__":
    main()
