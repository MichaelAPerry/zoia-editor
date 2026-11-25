import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { decodePatch } from '../decode.mjs'
import { connectionGain, createEngine, sampleRate, unsupportedModules } from '../engine/index.mjs'
import { layout, scaled } from '../engine/layout.mjs'
import { corpusFiles, corpusIndex, decodeFiles } from '../patch-files.mjs'
import { fillTestSignal } from '../signal.mjs'
import { decodeWav, floatWavHeader } from '../wav.mjs'

const module = (type_id, options = [], parameters = []) => ({ type_id, options, parameters })
const wire = (from, out, to, input, strength = 10000) => ({ source: [from, out], destination: [to, input], strength })
const patch = (modules, connections) => ({ modules, connections })
const raw = x => Math.round(x * 65535)
const impulse = size => Float64Array.from({ length: size }, (_, i) => i === 0 ? 1 : 0)
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `expected ${actual} within ${tolerance} of ${expected}`)
const rms = signal => Math.sqrt(signal.reduce((sum, value) => sum + value * value, 0) / signal.length)

function render(engine, left, right) {
  const outL = new Float64Array(left.length), outR = new Float64Array(left.length)
  for (let i = 0; i < left.length; i += engine.blockSize) {
    const end = i + engine.blockSize
    engine.processBlock(left.subarray(i, end), right?.subarray(i, end), outL.subarray(i, end), outR.subarray(i, end))
  }
  return [outL, outR]
}

function insert(record, inBlock, outBlock) {
  return createEngine(patch([module(1), record, module(2)], [
    wire(0, 0, 1, inBlock), wire(1, outBlock, 2, 0),
  ]))
}

test('fixed hardware indices and packed knobs survive hidden blocks', () => {
  const mono = layout(module(7))
  assert.deepEqual(mono.active.map(block => block[1]), [0, 2, 3])
  assert.deepEqual(mono.knobNames, ['level_control'])
  const delay = layout(module(43, [2, 1]))
  assert.deepEqual(delay.knobNames, ['mix', 'feedback', 'tap_tempo_in', 'mod_rate', 'mod_depth'])
  assert.ok(delay.active.some(([key, block]) => key === 'tap_tempo_in' && block === 5))
  assert.ok(layout(module(4, [3, 1])).active.some(([key, block]) => key === 'out_track_2' && block === 35))
  near(connectionGain(10000, true), 1)
  near(connectionGain(9398, true), 0.5, 0.0001)
  near(connectionGain(5000, false), 0.5)
})

test('VCA honors stored gain and live control overrides', () => {
  const engine = insert(module(7, [], [16384]), 0, 3)
  near(render(engine, impulse(1))[0][0], 16384 / 65535)
  engine.set(1, 'level_control', 0.5)
  near(render(engine, impulse(1))[0][0], 0.5)
  engine.set(1, 'level_control', 0)
  assert.equal(render(engine, impulse(1))[0][0], 0)
})

test('Delay Line hits the selected delay in samples', () => {
  const engine = insert(module(13, [5, 0, 1, 1]), 0, 4)
  engine.set(1, 'delay_time', 0.5)
  const [out] = render(engine, impulse(4801))
  assert.equal(out.findIndex(Boolean), 2400)
  assert.equal(out[2400], 1)
  assert.equal(out.reduce((sum, value) => sum + value, 0), 1)
})

test('Delay Line matches the three v2 hardware impulse lags', () => {
  for (const [setting, lag] of [[16384, 72], [32768, 133], [49152, 640]]) {
    const [out] = render(insert(module(13, [], [setting]), 0, 4), impulse(700))
    assert.equal(out.findIndex(Boolean), lag)
    assert.equal(out[lag], 1)
  }
})

test('Delay w/Mod adds 64 samples once on the wet path', () => {
  const [wet] = render(insert(module(43, [2], [65535, 32768, 32768, 32768, 0]), 0, 8), impulse(100000))
  const pulse = window => {
    const gain = window.reduce((sum, x) => sum + x, 0)
    const center = window.reduce((sum, x, i) => sum + i * x, 0) / gain
    return { gain, center }
  }
  const first = pulse(wet.subarray(0, 60000))
  const second = pulse(wet.subarray(60000))
  const spacing = 60000 + second.center - first.center
  near(spacing, 49489, 1)
  near(first.center - spacing, 64, 0.001)
  near(second.gain / first.gain, 0.5, 0.001)
})

test('Flanger starts at its saved tap period and falls back to 120 BPM without one', () => {
  for (const [saved_data_hex, period] of [['0036000000000000', 13824], [undefined, 24000]]) {
    const engine = insert({ ...module(69, [0, 1], [0, 0, 65535, 32768, 65535]), saved_data_hex }, 0, 9)
    const ramp = Float64Array.from({ length: period + 4000 }, (_, i) => i / sampleRate)
    const [out] = render(engine, ramp)
    const lag = index => (ramp[index] - out[index]) * sampleRate
    near(lag(1000 + period), lag(1000), 0.001)
    assert.ok(Math.abs(lag(1000 + Math.round(period / 2)) - lag(1000)) > 50)
  }
})

test('Buffer Delay and graph feedback have exact integer sample offsets', () => {
  const [buf] = render(insert(module(26, [2]), 0, 1), impulse(200))
  assert.equal(buf.findIndex(Boolean), 128)
  const graph = createEngine(patch([module(1), module(7, [], [65535]), module(2)], [
    wire(0, 0, 1, 0), wire(1, 3, 1, 0, 9398), wire(1, 3, 2, 0),
  ]), { blockSize: 17 })
  const [out] = render(graph, impulse(52))
  near(out[0], 1)
  near(out[17], connectionGain(9398, true))
  near(out[34], connectionGain(9398, true) ** 2)
  assert.equal(out[16], 0)
})

test('Edgy clips to its narrow rail with a fast smoothed attack', () => {
  const engine = insert(module(11, [4], [0, 65535]), 0, 2)
  const [out] = render(engine, Float64Array.of(1, 1))
  const first = 0.22 * 0.70
  near(out[0], first)
  near(out[1], first * Math.exp(-2 * Math.PI * 15 / sampleRate) + 0.70 * (0.22 - first))
})

test('Fuzz drives its rail at the input gain without an extra 2x', () => {
  const engine = insert(module(66, [0], [0, 65535]), 0, 3)
  const [out] = render(engine, Float64Array.of(0.4))
  near(out[0], 0.4 * 0.3)
})

test('SV lowpass is near -3 dB at cutoff and strongly attenuates a higher tone', () => {
  const run = frequency => {
    const engine = insert(module(0), 0, 3)
    engine.set(1, 'frequency', 0.5)
    const signal = Float64Array.from({ length: 24000 }, (_, i) => Math.sin(2 * Math.PI * frequency * i / sampleRate))
    const [out] = render(engine, signal)
    return rms(out.subarray(12000)) / rms(signal.subarray(12000))
  }
  near(run(880), Math.SQRT1_2, 0.025)
  assert.ok(run(8800) < 0.015)
  assert.ok(run(110) > 0.99)
})

test('LFO sine keeps its specified rate through short blocks', () => {
  const engine = createEngine(patch([module(5, [1, 0, 1]), module(2)], [wire(0, 3, 1, 0)]))
  engine.set(0, 'cv_control', 0.5)
  const [out] = render(engine, new Float64Array(sampleRate))
  near(out[12345], Math.sin(2 * Math.PI * 5.4 * 12345 / sampleRate), 1e-7)
  assert.equal(out.filter((x, i) => i > 0 && x > 0 && out[i - 1] <= 0).length, 6)
})

test('LFO uses the measured slow anchors, taper, and upper calibration', () => {
  const progress = ((1500 / 1050) ** 1.04396 - 1) / ((2142 / 1050) ** 1.04396 - 1)
  for (const [position, hz] of [
    [0, 0], [525 / 65535, 0.06131662 / 2], [1050 / 65535, 0.06131662],
    [1500 / 65535, 0.06131662 + (0.12906869 - 0.06131662) * progress],
    [2142 / 65535, 0.12906869], [0.25, 1.53],
  ]) {
    const engine = createEngine(patch([module(5, [1, 0, 1]), module(2)], [wire(0, 3, 1, 0)]))
    engine.set(0, 'cv_control', position)
    const [out] = render(engine, new Float64Array(1001))
    near(out[1000], Math.sin(2 * Math.PI * hz * 1000 / sampleRate))
  }
})

test('CV LFO follows the saved rate curve and interpolates in log Hz', () => {
  const engine = createEngine(patch([module(5, [1, 0, 1]), module(2)], [wire(0, 3, 1, 0)]))
  let phase = 0
  for (const [position, hz] of [
    [2360, 0.14308], [(2360 + 2428) / 2, Math.sqrt(0.14308 * 0.1475)],
    [5520, 0.36723], [19948, 2.09673], [5520, 0.36723],
  ]) {
    engine.set(0, 'cv_control', position / 65535)
    const [out] = render(engine, new Float64Array(1001))
    near(out[1000], Math.sin(phase + 2 * Math.PI * hz * 1000 / sampleRate))
    phase += 2 * Math.PI * hz * 1001 / sampleRate
  }
})

test('Ghostverb 75% sheds the 125 Hz octave faster than the 250 Hz octave', () => {
  const ghost = module(67, [0], [49152, 32768, 32768, 65535])
  const [wet] = render(insert(ghost, 0, 6), impulse(4 * sampleRate))
  const window = sampleRate / 5
  const bandPower = (seconds, octCenter) => {
    const start = Math.round(seconds * sampleRate)
    let power = 0
    for (let hz = 5 * Math.ceil(octCenter / (5 * Math.SQRT2)); hz < octCenter * Math.SQRT2; hz += 5) {
      const step = 2 * Math.PI * hz / sampleRate
      let real = 0, imaginary = 0
      for (let i = 0; i < window; i++) {
        const sample = wet[start + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / window))
        real += sample * Math.cos(step * i)
        imaginary += sample * Math.sin(step * i)
      }
      power += real * real + imaginary * imaginary
    }
    return power
  }
  const relativeTail = hz => bandPower(2.5, hz) / bandPower(0.5, hz)
  assert.ok(relativeTail(125) < 0.004)
  assert.ok(relativeTail(250) > 0.15)
})

test('wet Reverb Lite produces a decaying tail and flushes tiny inputs', () => {
  const engine = insert(module(79), 0, 4)
  engine.set(1, 'decay_time', 0.3)
  engine.set(1, 'mix', 1)
  const [out] = render(engine, impulse(4 * sampleRate))
  assert.equal(out[0], 0)
  const early = rms(out.subarray(1000, 12000))
  assert.ok(early > 0.0001)
  assert.ok(rms(out.subarray(-12000)) < early * 0.01)
  for (const x of out) assert.ok(Number.isFinite(x) && (x === 0 || Math.abs(x) >= 1e-24))
  const silent = insert(module(79), 0, 4)
  assert.equal(rms(render(silent, new Float64Array(4096).fill(1e-310))[0]), 0)
})

test('CV math, stored switches and unsupported modules preserve the rest of the graph', () => {
  const graph = createEngine(patch([
    module(44), module(45, [], [32768]), module(22), module(17), module(2), module(999),
  ], [wire(0, 0, 2, 0), wire(1, 1, 2, 1), wire(2, 8, 3, 0), wire(3, 1, 4, 0),
    wire(5, 0, 4, 1)]))
  assert.deepEqual(graph.unsupported, ['Type 999'])
  assert.equal(render(graph, impulse(1))[0][0], 0)
  graph.set('Stompswitch', 'state', 1)
  const [l, r] = render(graph, impulse(1))
  near(l[0], -32768 / 65535)
  assert.equal(r[0], 0)
})

test('sequencer tracks decode saved values and advance on gate edges', () => {
  const steps = Buffer.alloc(572)
  steps.writeUInt16LE(65535, 0)
  steps.writeUInt16LE(32768, 2)
  steps.writeUInt16LE(16384, 64)
  const seq = { ...module(4, [1, 1]), saved_data_hex: steps.toString('hex') }
  const engine = createEngine(patch([module(1), seq, module(2)], [
    wire(0, 0, 1, 32), wire(1, 34, 2, 0), wire(1, 35, 2, 1),
  ]))
  const [l, r] = render(engine, Float64Array.of(1, 0, 1, 0, 1))
  assert.deepEqual([...l], [1, 1, 32768 / 65535, 32768 / 65535, 1])
  assert.equal(r[0], 16384 / 65535)
})

test('24-bit mono and stereo float WAV preserve channels and full scale', () => {
  const pcm = Buffer.alloc(50)
  pcm.write('RIFF')
  pcm.writeUInt32LE(42, 4)
  pcm.write('WAVEfmt ', 8)
  pcm.writeUInt32LE(16, 16)
  pcm.writeUInt16LE(1, 20)
  pcm.writeUInt16LE(1, 22)
  pcm.writeUInt32LE(48000, 24)
  pcm.writeUInt32LE(144000, 28)
  pcm.writeUInt16LE(3, 32)
  pcm.writeUInt16LE(24, 34)
  pcm.write('data', 36)
  pcm.writeUInt32LE(6, 40)
  pcm.writeIntLE(-8388608, 44, 3)
  pcm.writeIntLE(4194304, 47, 3)
  assert.deepEqual(decodeWav(pcm), { left: Float32Array.of(-1, 0.5), right: undefined })
  const sample = Buffer.alloc(8)
  sample.writeFloatLE(0.25)
  sample.writeFloatLE(-0.75, 4)
  assert.deepEqual(decodeWav(Buffer.concat([floatWavHeader(1), sample])),
    { left: Float32Array.of(0.25), right: Float32Array.of(-0.75) })
})

test('generated binary Test Thru renders stereo input sample-for-sample', () => {
  const bytes = readFileSync(new URL('../../out/000_zoia_Test_Thru.bin', import.meta.url))
  const graph = createEngine(decodePatch(bytes))
  const left = new Float64Array(1001), right = new Float64Array(1001)
  fillTestSignal(left, right, 0)
  assert.deepEqual(graph.issues, [])
  const [actualL, actualR] = render(graph, left, right)
  assert.deepEqual(actualL, left)
  assert.deepEqual(actualR, right)
})

test('parameter units honor anchors and unity', () => {
  const meta = layout(module(76)).parameters.gain_1
  near(scaled(0.83, meta), 0)
  const vca = layout(module(7)).parameters.level_control
  assert.equal(scaled(0, vca), -Infinity)
  near(scaled(0.5, vca), -6.020599913)
})

test('Delay w/Mod time follows the linear range in its saved sample counts', () => {
  const { delay_time } = layout(module(43)).parameters
  // This tap-mode measurement is 1.9 ms above the rate-mode curve.
  near(scaled(3640 / 65535, delay_time), 172.0, 2)
  const savedTimes = [
    [8448, 312.2], [12280, 425.5],
    [16248, 542.9], [23193, 748.2], [40888, 1271.3],
  ]
  for (const [position, milliseconds] of savedTimes) {
    near(scaled(position / 65535, delay_time), milliseconds, 0.2)
  }
  const pingPong = layout(module(75)).parameters.delay_time
  near(scaled(1368 / 65535, pingPong), 4941 / 48, 0.1)
})

test('every module-supported corpus patch renders bounded audio with low DC', t => {
  const paths = corpusFiles()
  const patches = decodeFiles(paths)
  assert.equal(patches.length, corpusIndex().length)
  const frames = 4 * sampleRate
  const left = new Float64Array(frames), right = new Float64Array(frames)
  fillTestSignal(left, right, 0)
  const failures = []
  let rendered = 0
  for (const [i, patch] of patches.entries()) {
    if (patch.empty || unsupportedModules(patch).length) continue
    const [l, r] = render(createEngine(patch, { acCoupledOutput: true }), left, right)
    for (const [channel, output] of [['L', l], ['R', r]]) {
      let sum = 0, peak = 0
      for (const sample of output) {
        sum += sample
        peak = Math.max(peak, Math.abs(sample))
      }
      const mean = sum / frames
      if (!Number.isFinite(peak) || peak >= 16 || Math.abs(mean) >= 0.01) {
        failures.push(`${paths[i]} ${channel}: peak ${peak}, mean ${mean}`)
      }
    }
    rendered++
  }
  assert.ok(rendered > 0)
  t.diagnostic(`Rendered ${rendered} patches for four seconds at 48 kHz`)
  assert.deepEqual(failures, [])
})

test('sample and hold catches rising edges and ignores changes during a high gate', () => {
  const engine = createEngine(patch([module(1), module(10), module(2)], [
    wire(0, 0, 1, 0), wire(0, 1, 1, 1), wire(1, 2, 2, 0),
  ]))
  const [out] = render(engine, Float64Array.of(0.2, 0.4, 0.8, -0.1, -0.5), Float64Array.of(0, 1, 1, 0, 1))
  assert.deepEqual([...out], [0, 0.4, 0.4, 0.4, -0.5])
})

test('ADSR rises, sustains and releases from its current level', () => {
  const engine = insert(module(6, [], [0, 0, 0, 32768, 0]), 0, 9)
  const pulse = new Float64Array(320).fill(1, 0, 200)
  const [out] = render(engine, pulse)
  assert.ok(out[0] > 0 && out[0] < 0.025)
  assert.equal(out[63], 1)
  near(out[180], 32768 / 65535)
  assert.ok(out[200] < out[199] && out[200] > 0.45)
  assert.equal(out[265], 0)
})

test('mono Audio Mixer with panning exposes both outputs and honors channel gains', () => {
  const mixer = module(76, [0, 0, 1], [raw(0.83), raw(0.83), 0, 65535])
  const engine = createEngine(patch([module(1), mixer, module(2)], [
    wire(0, 0, 1, 0), wire(0, 1, 1, 2), wire(1, 32, 2, 0), wire(1, 33, 2, 1),
  ]))
  const [l, r] = render(engine, Float64Array.of(0.3), Float64Array.of(0.7))
  assert.deepEqual(engine.issues, [])
  near(l[0], 0.3, 0.0001)
  near(r[0], 0.7, 0.0001)
})

test('audio out switch holds its stored channel and can be changed', () => {
  const engine = createEngine(patch([module(1), module(34, [1], [raw(0.25)]), module(2)], [
    wire(0, 0, 1, 0), wire(1, 2, 2, 0), wire(1, 3, 2, 1),
  ]))
  const l = impulse(1)
  assert.deepEqual(render(engine, l).map(x => x[0]), [1, 0])
  engine.set(1, 'in_select', 0)
  assert.deepEqual(render(engine, l).map(x => x[0]), [1, 0])
  engine.set(1, 'in_select', 1)
  assert.deepEqual(render(engine, l).map(x => x[0]), [0, 1])
})

test('multi-channel audio in switch selects channel 1 at zero CV', () => {
  const engine = createEngine(patch([module(1), module(33, [1], [0]), module(2)], [
    wire(0, 0, 1, 0), wire(0, 1, 1, 1), wire(1, 17, 2, 0),
  ]))
  assert.deepEqual(engine.issues, [])
  const left = Float64Array.of(0.5), right = Float64Array.of(-0.75)
  assert.equal(render(engine, left, right)[0][0], 0.5)
  engine.set(1, 'in_select', 1)
  assert.equal(render(engine, left, right)[0][0], -0.75)
})

test('Tremolo hardware blocks carry stereo audio instead of its depth knob', () => {
  const graph = createEngine(patch([module(1), module(41, [2], [0, 65535]), module(2)], [
    wire(0, 0, 1, 0), wire(0, 1, 1, 1), wire(1, 5, 2, 0), wire(1, 6, 2, 1),
  ]))
  assert.deepEqual(graph.issues, [])
  const [l, r] = render(graph, Float64Array.of(0, 0.75, -0.75), Float64Array.of(0, -1, 1))
  assert.deepEqual([...l], [0, 0.375, -0.375])
  assert.deepEqual([...r], [0, 0, 0])
})

test('Euroburo stereo I/O, headphone level and external controls reach the graph', () => {
  const pushbutton = { ...module(97, [1]), saved_data_hex: '01000000' }
  const graph = createEngine(patch([module(93), module(94), module(95), module(96), module(92),
    module(88), pushbutton, module(7)], [
    wire(0, 0, 7, 0), wire(5, 0, 7, 2, 5000), wire(6, 1, 7, 2, 5000),
    wire(7, 3, 2, 0), wire(1, 0, 3, 0),
  ]))
  assert.deepEqual(graph.issues, [])
  const left = Float64Array.of(0.5), right = Float64Array.of(-0.75)
  assert.deepEqual(render(graph, left, right).map(x => x[0]), [0.25, -0.75])
  graph.set('Euro CV In 1', 'value', 1)
  graph.set('Euro Headphone Amp', 'level', 0.75)
  const [l, r] = render(graph, left, right)
  near(l[0], 0.5 * 10 ** -0.5)
  near(r[0], -0.75 * 10 ** -0.5)
  graph.set('Euro Pushbutton 1', 'state', 0)
  near(render(graph, left, right)[0][0], 0.25 * 10 ** -0.5)
})

test('MIDI clock is idle by default and emits timed quarter-note and clock pulses with BPM', () => {
  const midi = patch([module(82, [1, 1]), module(2)], [wire(0, 0, 1, 0), wire(0, 1, 1, 1)])
  const input = new Float64Array(24001)
  assert.deepEqual(render(createEngine(midi), input).map(rms), [0, 0])
  const [quarter, clock] = render(createEngine(midi, { bpm: 120 }), input)
  assert.deepEqual([quarter[0], quarter[48], quarter[1000], quarter[24000]], [1, 0, 0, 1])
  assert.deepEqual([clock[0], clock[48], clock[1000], clock[24000]], [1, 0, 1, 1])
})

test('Looper records on the saved record control and plays the recorded waveform on the next edge', () => {
  const graph = insert(module(30, [0, 0, 1], [65535]), 0, 6)
  assert.deepEqual([...render(graph, Float64Array.of(0.25, -0.5))[0]], [0, 0])
  graph.set(1, 'record', 0)
  render(graph, Float64Array.of(0.75))
  graph.set(1, 'record', 1)
  assert.deepEqual([...render(graph, new Float64Array(6))[0]], [0.25, -0.5, 0.75, 0.25, -0.5, 0.75])
})

test('Aetherverb has low DC before output coupling', () => {
  const demos = corpusFiles().filter(path => /aetherverb_v1_0-1/.test(path))
  assert.equal(demos.length, 1)
  const left = new Float64Array(3 * sampleRate), right = left.slice()
  fillTestSignal(left, right, 0)
  for (const [i, decoded] of decodeFiles(demos).entries()) {
    const engine = createEngine(decoded)
    assert.deepEqual(engine.issues, [])
    for (const channel of render(engine, left, right)) {
      assert.ok(rms(channel) > 0.001, demos[i])
      const mean = channel.reduce((sum, x) => sum + x, 0) / channel.length
      assert.ok(Math.abs(mean) < 0.001, `${demos[i]} mean ${mean}`)
    }
  }
})
