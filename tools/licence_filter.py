#!/usr/bin/env python3
"""Filter a staged public corpus using the licence field in its patch index."""

import argparse
import csv
import json
from pathlib import Path

BLANK = "112177_112187_BLANK-PATCHES__000_zoia_.bin"
BLANK_LICENCE = "Public domain (empty patch)"


def shareable(row):
    return bool(row["license"].strip())


def read_index(corpus):
    with (corpus / "INDEX.csv").open(newline="", encoding="utf-8-sig") as source:
        reader = csv.DictReader(source)
        return reader.fieldnames, list(reader)


def write_index(corpus, fields, rows):
    with (corpus / "INDEX.csv").open("w", newline="", encoding="utf-8") as target:
        writer = csv.DictWriter(target, fields)
        writer.writeheader()
        writer.writerows(rows)


def retain_patches(corpus, fields, rows):
    """Keep exactly the given indexed files and the posts represented by them."""
    names = {row["file"] for row in rows}
    files = {path.name: path for path in corpus.glob("*.bin")}
    if len(names) != len(rows) or names - files.keys():
        raise ValueError("Retained rows must name distinct existing patch files")
    posts = {name.split("_", 1)[0] for name in names}
    metadata = corpus / "patchstorage-meta.json"
    data = json.loads(metadata.read_text(encoding="utf-8"))
    if posts - data.keys():
        raise ValueError("Retained patches have missing PatchStorage posts")
    metadata.write_text(
        json.dumps({key: post for key, post in data.items() if key in posts},
                   ensure_ascii=True, indent=0) + "\n",
        encoding="utf-8",
    )
    write_index(corpus, fields, rows)
    for name in files.keys() - names:
        files[name].unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("corpus", type=Path, help="corpus directory in the staged public copy")
    parser.add_argument("--apply", action="store_true", help="remove excluded patches from the copy")
    args = parser.parse_args()
    fields, rows = read_index(args.corpus)
    kept = []
    for row in rows:
        if row["file"] == BLANK:
            row["license"] = BLANK_LICENCE
        if shareable(row):
            kept.append(row)
    if args.apply:
        retain_patches(args.corpus, fields, kept)
    print(f"{len(kept)} retained, {len(rows) - len(kept)} excluded")


if __name__ == "__main__":
    main()
