#!/usr/bin/env python3
"""Report SHA-1 duplicate groups in the patch corpus."""

import argparse
from collections import defaultdict
from hashlib import sha1
from pathlib import Path

CORPUS = Path(__file__).resolve().parents[1] / "corpus"


def duplicate_groups(corpus):
    by_digest = defaultdict(list)
    for patch in sorted(corpus.glob("*.bin")):
        by_digest[sha1(patch.read_bytes()).hexdigest()].append(patch.name)
    return {digest: names for digest, names in by_digest.items() if len(names) > 1}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("corpus", nargs="?", type=Path, default=CORPUS)
    corpus = parser.parse_args().corpus
    if not corpus.is_dir():
        parser.error(f"Corpus directory does not exist: {corpus}")
    groups = duplicate_groups(corpus)
    for digest, names in groups.items():
        print(digest)
        for name in names:
            print(f"  {name}")
    print(f"{len(groups)} duplicate groups")
    return bool(groups)


if __name__ == "__main__":
    raise SystemExit(main())
