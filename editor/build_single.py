#!/usr/bin/env python3
"""Build the offline ZOIA editor using only the Python standard library."""

import base64
import csv
import io
import json
import re
import zlib
from pathlib import Path

EDITOR = Path(__file__).resolve().parent
ZOIA = EDITOR.parent
IDENTIFIER = r"[A-Za-z_$][\w$]*"
NAMED = re.compile(
    r"(?m)^[ \t]*(import|export)[ \t]*\{([^{}]*)\}"
    r"(?:[ \t]+from[ \t]+(['\"])([^'\"]+)\3)?[ \t]*;?[ \t]*$"
)
DECLARATION = re.compile(
    rf"(?m)^[ \t]*export[ \t]+(?:const|function|class)[ \t]+({IDENTIFIER})(?=[ \t=(\n{{])"
)


def js_json(value):
    # Prevent embedded data from terminating an HTML script element.
    return json.dumps(value, ensure_ascii=True, separators=(",", ":")).replace("<", r"\u003c")


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise ValueError(f"Expected exactly one occurrence of {old!r}")
    return source.replace(old, new, 1)


class Bundle:
    """Translate the named ES module forms used by the editor and engine."""

    def __init__(self, transforms=None):
        self.transforms = transforms or {}
        self.modules = {}
        self.visiting = set()

    def visit(self, path):
        if path in self.modules:
            return self.modules[path]
        if path in self.visiting:
            raise ValueError(f"Module import cycle at {path}")
        self.visiting.add(path)
        source = path.read_text(encoding="utf-8")
        if path in self.transforms:
            source = self.transforms[path](source)
        imports = []
        exports = {}

        def add_export(name, expression):
            if name in exports:
                raise ValueError(f"{path}: duplicate export {name}")
            exports[name] = expression

        def named(match):
            kind, bindings, _, specifier = match.groups()
            dependency = None
            if specifier:
                target = (path.parent / specifier).resolve()
                if not specifier.startswith(("./", "../")) or not target.is_relative_to(ZOIA):
                    raise ValueError(f"{path}: unsupported module path {specifier!r}")
                dependency, available, _ = self.visit(target)
            elif kind == "import":
                raise ValueError(f"{path}: import requires a module path")

            for binding in bindings.strip().rstrip(",").split(","):
                names = re.fullmatch(
                    rf"({IDENTIFIER})(?:\s+as\s+({IDENTIFIER}))?", binding.strip()
                )
                if not names:
                    raise ValueError(f"{path}: unsupported {kind} binding {binding!r}")
                original, alias = names.groups()
                name = alias or original
                if dependency and original not in available:
                    raise ValueError(f"{path}: {specifier!r} does not export {original}")
                expression = f"{dependency}.{original}" if dependency else original
                if kind == "import":
                    imports.append(f"const {name} = {expression};")
                else:
                    add_export(name, expression)
            return ""

        def declared(match):
            name = match[1]
            add_export(name, name)
            return match[0].replace("export", "", 1)

        source = NAMED.sub(named, source)
        source = DECLARATION.sub(declared, source)
        unsupported = re.search(r"(?m)^\s*(?:import|export)\b|\bimport\s*[.(]", source)
        if unsupported:
            raise ValueError(f"{path}: unsupported JavaScript module syntax near {unsupported[0]!r}")
        namespace = f"__zoiaModule{len(self.modules)}"
        properties = ", ".join(f"[{js_json(name)}]: {value}" for name, value in exports.items())
        code = "\n".join((
            f"// {path.relative_to(ZOIA).as_posix()}",
            f"const {namespace} = (() => {{",
            *imports,
            source,
            f"return {{ {properties} }};",
            "})();",
        ))
        self.modules[path] = namespace, exports, code
        self.visiting.remove(path)
        return self.modules[path]

    def build(self, *entries):
        for entry in entries:
            self.visit(EDITOR / entry)
        return '"use strict";\n' + "\n".join(code for _, _, code in self.modules.values())


def patch_assets():
    corpus = ZOIA / "corpus"
    index = (corpus / "INDEX.csv").read_bytes()
    corpus_patches = {path.name: path for path in sorted(corpus.glob("*.bin"))}
    for row in csv.DictReader(io.StringIO(index.decode("utf-8-sig"))):
        if row["file"] not in corpus_patches:
            raise ValueError(f"Corpus index references missing patch {row['file']!r}")

    out = ZOIA / "out"
    bench = out / "bench" / "to_zoia"
    local_patches = {
        path.relative_to(out).as_posix(): path
        for directory in (out, bench)
        for path in sorted(directory.glob("*.bin"))
    }
    manifest = json.loads((EDITOR / "manifest.json").read_text(encoding="utf-8"))
    indexed = set()
    for row in manifest:
        name = row["file"]
        if name not in local_patches:
            name = f"bench/to_zoia/{name}"
        if name not in local_patches:
            raise ValueError(f"Local manifest references missing patch {row['file']!r}")
        row["file"] = name
        indexed.add(name)
    # Include unlisted local builds, including the bench output omitted by make_manifest.py.
    for name, path in local_patches.items():
        if name not in indexed:
            manifest.append({
                "file": name,
                "title": re.sub(r"^\d{3}_zoia_", "", path.stem).replace("_", " "),
                "author": "",
                "category": "Local build",
                "tags": path.parent.relative_to(ZOIA).as_posix(),
                "downloads": "",
            })

    assets = {"INDEX.csv": index, "manifest.json": js_json(manifest).encode("utf-8")}
    for directory, patches in (("corpus", corpus_patches), ("out", local_patches)):
        assets.update({f"{directory}/{name}": path.read_bytes() for name, path in patches.items()})
    return {name: base64.b64encode(zlib.compress(data, level=9)).decode("ascii")
            for name, data in assets.items()}


def offline_corpus(source):
    source = replace_once(source, "await fetch(path)", "await readEmbeddedAsset(path)")
    source = replace_once(source, "../${row.directory}/${encodeURIComponent(row.file)}",
                          "${row.directory}/${row.file}")
    return replace_once(source, "../corpus/INDEX.csv", "INDEX.csv")


def offline_audio(source):
    source = replace_once(
        source,
        "context.audioWorklet.addModule(new URL('../core/worklet.js', import.meta.url)),",
        "loadEmbeddedWorklet(context),",
    )
    return replace_once(
        source,
        "        context.audioWorklet.addModule(new URL('./recorder.js', import.meta.url)),\n",
        "",
    )


def main():
    worklet = Bundle().build("core/worklet.js", "ui/recorder.js")
    app = Bundle({
        EDITOR / "ui/corpus.js": offline_corpus,
        EDITOR / "ui/audio.js": offline_audio,
    }).build("ui/app.js")

    css = (EDITOR / "style.css").read_text(encoding="utf-8")
    if re.search(r"@import\b|@font-face\b|\burl\s*\(", css, re.I):
        raise ValueError("Unexpected CSS asset reference")

    script = f"""(() => {{
"use strict";
const embeddedAssets = {js_json(patch_assets())};
const embeddedWorklet = {js_json(worklet)};

async function readEmbeddedAsset(path) {{
  if (!Object.hasOwn(embeddedAssets, path)) throw new Error(`Missing embedded asset: ${{path}}`);
  const bytes = Uint8Array.from(atob(embeddedAssets[path]), char => char.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Response(stream);
}}

async function loadEmbeddedWorklet(context) {{
  // A file:// page has an opaque origin, so a blob:null worklet URL is refused as cross-origin.
  // data: URLs are same-origin for module fetches, so try that first and keep blob: as a fallback.
  const utf8 = new TextEncoder().encode(embeddedWorklet);
  let binary = '';
  for (let i = 0; i < utf8.length; i += 0x8000) binary += String.fromCharCode(...utf8.subarray(i, i + 0x8000));
  try {{
    await context.audioWorklet.addModule('data:text/javascript;base64,' + btoa(binary));
    return;
  }} catch (error) {{
    console.warn('data: worklet failed, trying blob:', error);
  }}
  const url = URL.createObjectURL(new Blob([embeddedWorklet], {{ type: 'text/javascript' }}));
  try {{
    await context.audioWorklet.addModule(url);
  }} finally {{
    URL.revokeObjectURL(url);
  }}
}}

// Editor modules
{app}
}})();
"""
    if re.search(r"</script\b", script, re.I) or re.search(r"</style\b", css, re.I):
        raise ValueError("Unexpected HTML closing tag in bundled source")
    html = (EDITOR / "index.html").read_text(encoding="utf-8")
    html = replace_once(html, '<link rel="stylesheet" href="style.css">', f"<style>\n{css}</style>")
    html = replace_once(html, '<script type="module" src="ui/app.js"></script>',
                        f"<script>\n{script}</script>")
    output = EDITOR / "dist/zoia-editor.html"
    output.parent.mkdir(exist_ok=True)
    data = html.encode("utf-8")
    output.write_bytes(data)
    print(f"{output.relative_to(EDITOR)}: {len(data):,} bytes ({len(data) / 2**20:.2f} MiB)")


if __name__ == "__main__":
    main()
