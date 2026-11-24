# Offline ZOIA simulator

Audition decoded ZOIA pedal patches at 48 kHz. The simulator runs in Node 26 with no npm packages. Its DSP engine uses JavaScript ES modules and typed arrays, so the same engine can be imported by an AudioWorklet.

## Render a patch

Run these commands from the repository root.

```sh
python3 -B -m zoiacodec decode corpus/121392_121391_061_zoia_aetherverb_v1_0-1.bin sim/aetherverb.json
node sim/render.mjs sim/aetherverb.json --out out/sim_aetherverb.wav --seconds 3

node --test sim/tests/
node sim/coverage.mjs
```

Pass `--in input.wav` for a mono or stereo RIFF WAV with signed 16- or 24-bit PCM or 32- or 64-bit IEEE float samples. Mono duplicates to both input channels. Rates other than 48 kHz use linear interpolation. With a WAV input, duration defaults to the input length. Use `--seconds` to trim it or pad it with silence for tails. Without an input, the render defaults to four seconds and starts with a stereo click and four decaying plucks.

Output is 48 kHz, 32-bit float stereo WAV with a simulated 15 Hz AC-coupled audio output. The CLI prints unsupported modules, unmapped connections between supported modules, and per-channel peak, RMS, and signed mean in linear full-scale units. Values above 1.0 can be present in the float file.

Repeat `--set "module:param=value"` to override controls. Use the zero-based index, unique saved name, or unique module type name. Parameter keys come from the module index. Values are normalized knob positions, with `1` equal to raw `65535`. Set button and stompswitch states to `0` or `1`. For example, `--set "6:state=1"` selects the fuzz route in *Shoegaze CE*. Routing switches start from the saved selector and can also receive CV. Use `--set "Euro CV In 1:value=0.4"` or `--set "Cport Exp/CV In:value=-0.2"` for external CV. Use `--bpm 120` to drive MIDI Clock In. Its outputs idle at zero if BPM is omitted.

Repeat `--cc seconds:channel:controller:value` to send timed MIDI CC messages. For example, `--cc 3:2:20:127` sends CC 20 at three seconds on MIDI channel 2.

## Engine API

```js
import { createEngine, sampleRate } from './engine/index.mjs'

const engine = createEngine(decodedPatch, { blockSize: 64, seed: 1, bpm: 120 })
const leftOut = new Float32Array(engine.blockSize)
const rightOut = new Float32Array(engine.blockSize)
engine.processBlock(leftIn, rightIn, leftOut, rightOut)
```

Buffers are planar. An omitted right input duplicates the left. The output length sets the number of frames to process and may be shorter than `blockSize`. Split larger host buffers before calling. Each instance retains its control, delay and filter state. Pass `acCoupledOutput: true` to use the renderer’s output stage. The engine API defaults to direct graph output. A future browser host needs to supply 48 kHz audio or handle resampling.

Call `engine.sendMidiCC(channel, controller, value)` between blocks to update matching MIDI CC In modules. For Sampler, pass `samples: { [moduleIndex]: { left, right } }` in the engine options to preload 48 kHz planar PCM. The key is the zero-based module position in the patch's module array. Omitting the right channel duplicates the left. Each sampler instance keeps a private copy.

The graph runs in dependency order per sample. Back edges found by depth-first traversal read their source `blockSize` samples earlier, even across short calls. Feedback history saturates at ±1 and DSP states flush signals below 10⁻²⁴. Acyclic connections have no additional routing latency. Audio and CV connections sum at their destination. CV adds to the saved knob position before conversion to physical units.

## Module support

**Exact** indicates a direct signal operation under the simulator’s graph and scaling rules. **Approximate** indicates reconstructed parameter behavior, timing, or signal processing. Firmware 5.41 bench measurements and remaining differences are documented in [CALIBRATION.md](../CALIBRATION.md).

| Modules | Support | Behavior |
| --- | --- | --- |
| Audio Input, Audio Output | Exact for unity | Stereo and single-channel channels, with scaled optional output gain. |
| Euro Audio Input 1–2, Euro Audio Output 1–2 | Exact for unity | Physical routes map directly to WAV left and right. Input pad options are ignored. |
| Euro Headphone Amp | Approximate | Applies its saved level to the summed stereo render. |
| Euro CV In 1–4, Cport Exp/CV In | Static | Normalized CV starts at zero and can be overridden with `value`. |
| Euro CV Out 1–4, Device Control | No-op | External CV sinks and device-wide controls. |
| MIDI Notes In, MIDI Pitch Bend, MIDI Pressure, Keyboard | Idle | Zero outputs. |
| MIDI CC In | Approximate | Holds the latest value for its configured channel and controller. Supports unipolar and bipolar CV. |
| MIDI PC Out, MIDI Clock Out, Cport CV Out | No audio by design | Silent sinks. |
| MIDI Clock In | Approximate | Zero by default. Optional simulated tempo supplies beat pulses, 24 PPQN clock, run and initial reset. |
| VCA | Exact | Linear amplitude, including mute and unity. |
| Audio Mixer, Audio Balance, Audio Panner, Stereo Spread | Approximate | Channel gain, mono/stereo summing, linear crossfade, pan laws, mid/side gain or Haas delay. |
| Value, Multiplier, CV Invert, CV Mixer | Exact for basic math | Bipolar or unipolar Value, CV product and sign inversion, and polarized summing or average. |
| Sample and Hold, Random, Noise, Comparator | Approximate | Thresholded sampling and tracking, seeded pseudorandom CV or white noise, threshold comparison. |
| LFO, Oscillator | Approximate | Standard waveforms with approximate CV rate/pitch, phase, duty, and tap controls. Oscillator waves can alias. |
| ADSR, Slew Limiter, Env Follower | Approximate | Linear envelope stages and slew, one-pole amplitude tracking. |
| SV Filter, Multi Filter, Tone Control | Approximate | State-variable low/band/high-pass and biquad shelving and peak EQ. |
| Delay Line, CV Delay, Buffer Delay | Approximate overall | Sample-addressed delay, optional fractional interpolation for Delay Line, and 64 samples per Buffer Delay buffer. Time and tempo conversion are estimated. Delay Line memory saturates at full scale. |
| Delay w/Mod, Ping Pong Delay | Approximate | Interpolated echo, recirculating or cross-channel feedback, tone models based on feedback low-pass filtering, and tap ratios. |
| Reverse Delay | Approximate | Reverses successive capture windows with resampled pitch, tap control and feedback. |
| Univibe | Approximate | Vibrato and swept allpass stages with resonance and wet/dry mix. |
| Chorus, Vibrato, Tremolo, Phaser, Flanger | Approximate | Modulated delays, gain and cascaded allpasses. Several model and waveform variants share an algorithm. |
| Diffuser, All Pass Filter | Approximate | Cascaded modulated delay allpasses and first-order allpasses. |
| Reverb Lite, Plate Reverb, Hall Reverb, Room Reverb, Ghostverb | Approximate | Freeverb-style damped combs and serial allpasses. Sizes, damping, and EQ vary by model. Ghostverb adds modulation and coloration. |
| OD & Distortion, Fuzz | Approximate | Soft or hard clipping with model-dependent filtering and a DC blocker after the clipping stage. |
| Bit Crusher, Aliaser | Approximate | Amplitude quantization and sample-rate reduction. |
| Compressor, Gate | Approximate | Peak envelope and gain control, with stereo linking and optional external sidechain. |
| Logic Gate | Approximate | Boolean operations on thresholded CV, with parity for multi-input XOR and XNOR. |
| Clock Divider, Sequencer, Trigger | Approximate | Tap or CV clock, pulse generation, and saved multitrack steps. |
| Stompswitch, Pushbutton, UI Button, Euro Pushbutton 1–2 | Approximate | Static initial states and manual `state` override. UI Button display is ignored. |
| In Switch, Out Switch, Audio In Switch, Audio Out Switch | Approximate | Stored or CV-controlled selectors with discrete switching. |
| Audio Multiply, Inverter | Exact at full-scale levels | Bipolar sample product with output saturation, and sign inversion. |
| CV Rectify | Exact | Absolute value. |
| CV Flip Flop | Approximate | Saved latch state with thresholded rising-edge toggles. |
| Tap to CV, CV Filter | Approximate | Tap interval mapped to CV, and one-pole CV smoothing with linked or separate rise and fall times. |
| Quantizer, Steps | Approximate | Nearest note in common scales and clocked sample-and-hold at subdivisions of an estimated input period. |
| CV Loop, Looper | Approximate | In-memory recording and playback controlled by saved knob positions and CV, with basic loop edits, speed and audio overdub/reverse options. Audio recording saturates at full scale. |
| Sampler | Approximate | Engine-local stereo recording and playback with trigger, gate and loop modes, edits, and optional position and end CV. See the [Empress Sampler/Sequencer Guide](https://empresseffects.com/blogs/support-zoia/zoia-sampler-sequencer-guide). |
| Rhythm | Approximate | Captures trigger times and replays them once per play edge. |
| Pitch Shifter, Granular | Approximate | Crossfaded variable delay taps and windowed grains from a rolling buffer. |
| Cabinet Sim, Env Filter | Approximate | Cabinet voicing from biquad EQ and envelope-controlled state-variable filtering. |
| Ring Modulator, Bit Modulator | Approximate | Internal or external carrier multiplication and signed 16-bit bitwise operations. |
| Pitch Detector, Onset Detector | Approximate | Positive zero-crossing periods converted to pitch CV and envelope-change triggers. |
| Pixel | No-op | Display-only. |
| All other module types | Unsupported | The engine reports these and treats their outputs as silence. |

## Layout and scaling sources

- Fixed block indices, option values, default knobs, and scaling anchors come from the zoia_lib module index and binary parser. Packed knob order follows `param_defaults.order` within the active layout, with corpus-informed overrides for delay effects and Plate Reverb. Plate Reverb stores mix, decay, low EQ and high EQ in that order. The corpus also places Sequencer tracks at hardware blocks 34–41, Tremolo depth at block 4 and its audio outputs at 5–6, and exposes both Audio Mixer outputs when panning is enabled. Metadata retains its original GPL-3.0 provenance. [zoia_lib](https://github.com/meanmedianmoge/zoia_lib) · [License](../zoiacodec/LICENSE)
- The simulator linearly interpolates ordinary anchors and uses geometric interpolation between widely spaced positive Hz or time anchors. VCA and feedback use linear amplitude. Delay Line uses an exponential curve for its unclocked time knob, with calibration for the 1 s interpolated setting and a separate linear-CV mode. [zoia_lib](https://github.com/meanmedianmoge/zoia_lib)
- Raw connection strength `10000` is unity. CV uses `raw / 10000`. Audio uses `(raw - 10000) / 100` dB, inferred from corpus values such as `9398` (roughly −6 dB) and `11200` (+12 dB). Raw zero mutes. [Binary recon](../RECON.md)
- The coverage runner and binary smoke tests use the local JavaScript decoder. Its audition fields were compared with the Python codec on Test Thru and all corpus files available at the time of the audit (414 files). Python remains the full decoder and encoder for editor metadata and round trips.

## Known gaps

- Module coverage means that every type has an implementation. In the public corpus, 232 of 233 files meet that criterion. *Instru to MIDI* requires MIDI CC Out and MIDI Note Out.
- Fourteen module-supported files in the public corpus have inactive or unmapped connections. The engine reports and skips these connections.
- Timing, curves between anchors, non-unity audio gain, and saved-data interpretations are estimates. The unobserved Tremolo direct-control jack is modeled at block 7. Sequencer editing, switch fades, physical control events, live MIDI transport, exact quantizer scale indexing, reverb freeze and hardware modulation details remain incomplete. Looper starts with empty memory because corpus patches contain no recorded samples. Granular freeze and timing are simplified. Sampler SD-card file selection and persistence are outside the engine.
- A patch may be quiet or silent in its saved state or may require external events. The corpus regression exercises four seconds of the built-in signal at 48 kHz and checks finite samples, peak magnitude below 16, and per-channel absolute mean below 0.01. Aetherverb also has a separate regression on the raw graph output.
