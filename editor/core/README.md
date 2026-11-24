# ZOIA editor core

Pass B can import these ES modules directly in the browser and in Node. Serve the `editor/` and `sim/engine/` paths with their relative directory structure intact.

## Binary codec

`encode.js` exports `decodePatch(bytes)` and `encodePatch(patch)`. Decode accepts an ArrayBuffer or Uint8Array, including a Node Buffer. Encode returns a 32,768-byte Uint8Array. The patch object uses the [Python codec's JSON fields](../../RECON.md#json-and-cli). Use this decoder for editing and exporting. It retains raw names, option bytes, module save data, extended colors, stars, payload tails and padding. Empty slots use `{ empty: true }`. An undecodable body with a valid header uses `opaque_body_hex`; the binary and text codecs can still round-trip it.

```js
import { decodePatch, encodePatch } from './core/encode.js'
import { newPatch, PatchModel } from './core/model.js'

const model = newPatch('Thru')
const input = model.addModule('Audio Input', { position: 0, name: 'In' })
const output = model.addModule('Audio Output', { position: 8, name: 'Out' })
model.connect([input, 'output_L'], [output, 'input_L'])
model.connect([input, 'output_R'], [output, 'input_R'])
const bytes = encodePatch(model.patch)
const reopened = new PatchModel(decodePatch(bytes))
```

## Model

`newPatch(name)` returns a model with one unnamed page. `new PatchModel(patch)` opens imported JSON. `model.patch` and `model.toJSON()` return detached snapshots. Use the snapshot for encoding, text export, or the worklet's `loadPatch`. All indices are zero-based. Module and cable indices can change after deletion, so refresh references from the snapshot. Names in binary records are at most 16 ASCII bytes without NUL.

| Operation | Contract |
| --- | --- |
| `addModule(type, {page, position, options, name, color})` | Returns the index. Type is a module type ID or catalog name. Position is required. Page defaults to 0, color to 1, and named options to their first choices. Supply options as a map of catalog choices or as up to eight raw bytes. Colors are numeric IDs 1–15. A legacy color table supports IDs 1–7. |
| `renamePatch(name)`, `renameModule(module, name)` | Update the binary name and record the edit in history. |
| `setModuleColor(module, color)` | Sets a color from 1–15, or 1–7 for a patch with a legacy color table. |
| `moveModule(module, {page, position})` | Moves to an existing page. Omitted coordinates keep their current values. |
| `deleteModule(module)` | Removes the module, incident cables and affected stars. |
| `setOption(module, name, value)` | Takes a catalog option name and choice. Keeps surviving knob values, cables and stars by block name and supplies defaults for newly visible knobs. |
| `setParam(module, block, raw)` | Sets a visible knob from an integer 0–65535. Returns the raw word. |
| `setParamDisplay(module, block, value)` | Takes a numeric value in the block's display units and returns the nearest raw word, clamped to the range. Use `-Infinity` for the bottom endpoint of a taper with mute. |
| `connect([from, block], [to, block], strength)` | Returns the cable index. Strength can be a bare raw integer, `{raw}`, or `{db}`. The default is 10000 (unity). Audio dB uses hundredths above or below the unity word. CV and mixed cables use linear amplitude conversion from dB. |
| `setConnectionStrength(connection, strength)` | Sets the strength using the same raw/dB rules as `connect`. Preserves the cable's index and star and returns the encoded raw word. |
| `disconnect(connection)` | Removes the cable and its star if present. |
| `addPage(name)`, `renamePage(page, name)`, `deletePage(page)` | Adding returns the page index. Deleting removes its modules and shifts subsequent page indices. `pageCount` includes implicit pages from imported module records. |
| `starParam(module, block, midiCC)`, `unstarParam(module, block)` | Adds, updates or removes a knob star. MIDI CC defaults to `null` and accepts 0–127. |
| `undo()`, `redo()` | Restore the previous or next snapshot. Return a boolean. `canUndo` and `canRedo` are getters. A changed edit after undo clears redo. |
| `validate()` / `validatePatch(patch)` | Returns findings as `{severity, code, message, module?, connection?}`. Checks placement, module IDs, cable endpoints and directions, signal mismatches, and the binary size budget. |

Placement occupies consecutive cells starting at `position` on an 8-column by 5-row grid. It may continue on the next row through position 39. Invalid placements and cable directions throw. Audio/CV mismatches are warnings. Failed edits leave the patch and history intact. `deleteModule`, `deletePage`, `setOption` and `disconnect` return `{ droppedConnections, droppedStars }`. Each dropped cable includes its original `index`.

### Catalog and display

- `moduleTypes` is an array of `{id, name}` entries. `optionDefinitions(type)` returns `{name, index, values}` entries. Use the actual value from `values`, including numeric choices.
- `model.blocks(module, {includeHidden})` or `moduleBlocks(record, {includeHidden})` describes the visible blocks by default. Each entry has a `name`, binary `index`, and grid `slot` (null for hidden blocks). Endpoints such as a Value input and output can share a slot. Use the block name or binary index for model edits. The editor uses `gridFootprint(patch, module)` to place imported modules, including compact layouts and fixed Euroburo hardware controls.
- `kind` is `audio_in`, `audio_out`, `cv_in`, `cv_out`, or `param`. For a parameter jack, `signal` gives its electrical routing kind. `parameterIndex` is the packed storage index, or −1 when the block has no visible knob. Each block includes `units` and `range`. Knobs also include `display(raw)`, `defaultRaw` and `guessed`. `rawFromDisplay(block, value)` performs the inverse. Controls with textual anchors expose optional `labels` and an editable normalized value.
- Visibility and packed order use the simulator's corpus-informed layout and the vendored zoia_lib and zoia-editor rules. Sequencer and Tremolo wire indices follow observed corpus wiring. MIDI Clock In visibility follows the vendor's block rules. Firmware-specific layouts and option-dependent saved payloads still need hardware verification. Option edits preserve opaque module data as imported.
- VCA dB is derived from its linear amplitude control. Delay Line uses the reconstructed v5.41 exponential curve and estimated option capacities and linear behavior. The live simulator still uses its existing Delay Line approximation, so its timing can differ from the editor's display. Other Hz, time and nonlinear dB tapers are estimates from catalog anchors. Display confidence is exposed as `guessed`.
- Validation uses the fixed binary budget for module and cable counts. The vendored zoia-editor compiler's 64-module cap applies to its authoring format. A hardware-wide module or connection cap has not been confirmed here.

## Patch text

`text.js` exports `patchToYaml(patch)` and `yamlToPatch(text)`. They use a small indented format with JSON quoting and inline option maps.

```text
ZOIA 1
  name "Wet Delay"
  page "Main"
  module In 1 "Audio Input"
    name "In"
    at 0 0
    options {"channels":"left"}
  module Delay 13 "Delay Line"
    name "Delay"
    at 0 8
    options {"max_time":"2s"}
    knob delay_time = 400 ms
  module Out 2 "Audio Output"
    name "Out"
    at 0 16
    options {"channels":"left"}
  cable In.output_L -> Delay.audio_in = 10000
  cable Delay.audio_out -> Out.input_L = 10000
```

`at` takes page and position. The tag after `module` is a unique alias used by cables. The type ID controls encoding. Cable strengths are raw words. For a knob use its display value and units, or `raw N`. A `#N` knob key addresses a packed parameter slot. A `#N` endpoint addresses a hardware block and `@N` references a module by index. Export uses raw values when the display taper maps multiple words to the same value. A compact `opaque` JSON line carries codec metadata, including colors and stars. Its per-record indices follow declaration order. Run `validatePatch` after parsing to get grid and routing findings.

## AudioWorklet

Load the module into a 48 kHz context and instantiate its registered processor.

```js
const context = new AudioContext({ sampleRate: 48000 })
await context.audioWorklet.addModule(new URL('./core/worklet.js', import.meta.url))
const live = new AudioWorkletNode(context, 'zoia-simulator', {
  numberOfInputs: 1,
  numberOfOutputs: 1,
  outputChannelCount: [2],
})
live.port.postMessage({ type: 'loadPatch', id: 1, patch: model.patch })
```

| Request `type` | Fields and behavior |
| --- | --- |
| `loadPatch` | `patch` is codec JSON. Builds a DSP graph and starts a linear crossfade. During an active fade, the latest pending graph starts at the next 64-frame boundary after the fade. |
| `setParam` | `module` is a numeric index, `block` a name or binary index, and `raw` an integer 0–65535. Applies to the latest loaded graph, including a queued graph. |
| `setState` | `module` is an index or unique engine alias, and `state` is a boolean or 0/1. Sets a pushbutton or stompswitch. |
| `reset` | Rebuilds the latest loaded graph from its original JSON, clearing live overrides and DSP state. |
| `getMeters` | Returns `{type: 'meters', id, peak: [left, right], cpuMs: [...]}` for the latest quantum. Peaks are absolute linear full-scale amplitudes. Each CPU entry measures one 64-frame block of render time, including both graphs during a fade. Worklet clocks without `performance.now()` use millisecond-resolution `Date.now()`. |

Each response echoes the optional request `id`. Mutations return `{type: 'ok', id, command}`. Load and reset also include the engine's `unsupported` and `issues` arrays. Rejected commands return `{type: 'error', id, command, message}`. The processor duplicates mono input, splits a 128-frame quantum into two 64-frame engine calls, and starts in silence. Set `processorOptions.fadeFrames` to override the default 1024-frame fade. Zero switches immediately. The same options object accepts engine `bpm`, `seed`, and `acCoupledOutput`.

## Tests

From the repository root:

```sh
node --test --test-isolation=none editor/tests/*.test.js
node --test --test-isolation=none --test-skip-pattern='every module-supported corpus patch' sim/tests/engine.test.mjs
```

The editor suite runs offline and uses the local Python codec for encoder parity. The worklet tests mock the processor global in Node. The second command runs the simulator's fast suite.
