# ZOIA Patch Editor

Run `python3 editor/build_single.py` from the repository root to rebuild `editor/dist/zoia-editor.html`. Double-click that HTML file to open the editor offline. The file includes the simulator and patch library.

Use a browser with AudioWorklet for playback and DecompressionStream for the embedded patch library. Some browsers block microphone access on `file://` pages. Chrome allows it after a permission prompt when a microphone is available. Autosave depends on the browser allowing localStorage for the file URL.
