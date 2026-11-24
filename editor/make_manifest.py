#!/usr/bin/env python3
"""Index local binary builds from out for the browser's corpus picker."""
import json
import re
from pathlib import Path

editor = Path(__file__).resolve().parent
rows = [
    {
        "file": patch.name,
        "title": re.sub(r"^\d{3}_zoia_", "", patch.stem).replace("_", " "),
        "author": "",
        "category": "Local build",
        "tags": "out",
        "downloads": "",
    }
    for patch in sorted((editor.parent / "out").glob("*.bin"))
    if patch.is_file()
]
(editor / "manifest.json").write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
