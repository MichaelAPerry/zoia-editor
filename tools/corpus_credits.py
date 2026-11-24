#!/usr/bin/env python3
"""Generate corpus/LICENSES.md from the public patch index."""

import argparse
from pathlib import Path

from licence_filter import BLANK_LICENCE, read_index


def cell(value):
    return value.replace("\\", "\\\\").replace("|", "\\|").replace("\r", "").replace("\n", " ")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("corpus", nargs="?", type=Path,
                        default=Path(__file__).resolve().parents[1] / "corpus")
    corpus = parser.parse_args().corpus
    _, rows = read_index(corpus)
    lines = [
        "# Patch licences",
        "",
        "Each patch remains under its author's licence. The editor's GPL-3.0 licence",
        "does not apply to the corpus as a collection. This table provides attribution",
        "and links to the original PatchStorage posts, including their author profiles.",
        "",
        f"The single blank patch is labelled **{BLANK_LICENCE}** because",
        "it contains no copyrightable material.",
        "",
        "Regenerate this table with `python3 -B tools/corpus_credits.py`.",
        "",
        "| Title | Author | Licence | PatchStorage URL |",
        "| --- | --- | --- | --- |",
    ]
    for row in rows:
        title, author, licence, url = (cell(row[key]) for key in ("title", "author", "license", "url"))
        lines.append(f"| {title} | {author} | {licence} | <{url}> |")
    (corpus / "LICENSES.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
