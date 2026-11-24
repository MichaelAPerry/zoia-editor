# Patch Editor for the ZOIA

A browser-based patch editor for the ZOIA pedal. It is drawn like the pedal: a black enclosure, the 8 x 5 grid of buttons lit in module colours, an OLED-style display, the knob and the three stompswitches. It runs as one HTML file, fully offline.

Unofficial. This project is not affiliated with, endorsed by or supported by the pedal's manufacturer.

## What it does

- Opens and saves ZOIA `.bin` patches (byte-exact round trip for all 414 corpus patches) and a plain-text patch format.
- Places modules on the grid, cables them, edits options, colours, names and pages.
- Lets you turn the knob (scroll, drag up/down, or arrow keys; hold Shift for fine) on the selected knob button. The display shows the module, parameter and value as on the pedal's parameter screen.
- Plays the patch through a built-in simulator (AudioWorklet), with a pluck, drum, click, noise, file or live input, and records 10 s to WAV.
- Browses an embedded library of patches, autosaves to the browser, prints patch sheets.
- The page follows your light/dark setting. The pedal stays black.

## Open it offline

Double-click `editor/dist/zoia-editor.html`. No server, network or fonts needed. Playback needs a browser with AudioWorklet; the library needs DecompressionStream (any current Chrome, Edge, Firefox or Safari).

## Rebuild the single file

```sh
python3 editor/build_single.py
```

Requires Python 3 only. The output is `editor/dist/zoia-editor.html`.

For development you can also serve the source: `./editor/serve.sh`, then open http://localhost:8280/editor/.

## Tests

Node 22 or newer, no packages.

```sh
node --test --test-isolation=none editor/tests/*.test.js
node --test --test-isolation=none --test-skip-pattern='every module-supported corpus patch' sim/tests/*.mjs
python3 -B -m unittest discover -s tests
```

`tools/cdp-clickthrough.mjs` drives the built file in headless Chromium through the main flows and writes screenshots (set `CHROME` to a Chromium binary; it always launches with `--mute-audio`):

```sh
node tools/cdp-clickthrough.mjs "$PWD/editor/dist/zoia-editor.html" "$PWD/screenshots" /tmp/zoia-downloads
```

## Layout

| Path | What |
| --- | --- |
| `editor/` | The editor: `core/` (codec, model, module data), `ui/`, `style.css`, `index.html`, build scripts, tests |
| `zoiacodec/` | Python reference codec for `.bin` patches (used by tests for encoder parity) |
| `sim/` | The JavaScript DSP simulator used for playback |
| `corpus/` | Community patches used for testing and the library (see licensing note) |
| `out/` | Local bench patches shown in the library |
| `screenshots/` | Output of the click-through |
| `RECON.md` | Notes on the binary format |

## Licence and credits

GPL-3.0, see `LICENSE`. The patch format and module data come from [zoia_lib](https://github.com/meanmedianmoge/zoia_lib) (GPL-3.0) by meanmedianmoge, with the format decoded by djigneo/apparent1 and the encoder work by Sranderley. See `HISTORY.md`.

The patches in `corpus/` were downloaded from PatchStorage and belong to their authors (see `corpus/patchstorage-meta.json`). Check their licences before publishing this repository or redistributing the single file, which embeds them.
