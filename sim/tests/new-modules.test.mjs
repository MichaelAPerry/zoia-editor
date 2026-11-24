import assert from 'node:assert/strict'
import test from 'node:test'
import { decodePatch } from '../../editor/core/decode.js'
import { encodeBinary } from '../../editor/core/encode.js'
import { newPatch } from '../../editor/core/model.js'
import { createEngine, sampleRate } from '../engine/index.mjs'

const connection = (from, out, to, input) => ({
  source: [from, out], destination: [to, input], strength: 10000,
})
const module = (type_id, options = []) => ({ type_id, options })

function render(engine, left, right) {
  const l = new Float64Array(left.length), r = new Float64Array(left.length)
  for (let offset = 0; offset < left.length; offset += engine.blockSize) {
    const end = offset + engine.blockSize
    engine.processBlock(left.subarray(offset, end), right?.subarray(offset, end),
      l.subarray(offset, end), r.subarray(offset, end))
  }
  return [l, r]
}

test('Logic Gate implements each truth table and the optional threshold', () => {
  const tables = [[0, 0, 0, 1], [0, 1, 1, 1], [1, 0, 0, 0], [1, 1, 1, 0],
    [0, 1, 1, 0], [1, 0, 0, 1], [1, 1, 0, 0]]
  for (const [op, table] of tables.entries()) {
    const engine = createEngine({
      modules: [module(105, [op, 0, 1]), module(2)],
      connections: [connection(0, 39, 1, 0)],
    })
    engine.set(0, 'threshold', 0.75)
    for (const [i, expected] of table.entries()) {
      engine.set(0, 'in_1', i & 2 ? 1 : 0.6)
      if (op !== 6) engine.set(0, 'in_2', i & 1 ? 1 : 0.6)
      assert.equal(render(engine, new Float64Array(1))[0][0], expected)
    }
  }
})

test('Reverse Delay plays the preceding capture buffer backwards', () => {
  const engine = createEngine({
    modules: [module(1), module(106, [1]), module(2)],
    connections: [connection(0, 0, 1, 0), connection(0, 1, 1, 1),
      connection(1, 8, 2, 0), connection(1, 9, 2, 1)],
  })
  for (const [key, value] of Object.entries({ delay_time: 0, feedback: 0, mix: 1, pitch: 0.5 }))
    engine.set(1, key, value)
  const left = new Float64Array(6000), right = new Float64Array(6000)
  left.set([0.25, 0.5, 0.75], 2997)
  right.set([-0.5, -0.25], 2998)
  const [l, r] = render(engine, left, right)
  assert.ok(l.subarray(0, 3000).every(value => value === 0))
  assert.deepEqual([...l.subarray(3000, 3004)], [0.75, 0.5, 0.25, 0])
  assert.deepEqual([...r.subarray(3000, 3004)], [-0.25, -0.5, 0, 0])
})

test('Univibe changes tone amplitude with a period set by the rate knob', () => {
  const amplitude = (rate, period) => {
    const engine = createEngine({
      modules: [module(1), module(107), module(2)],
      connections: [connection(0, 0, 1, 0), connection(1, 8, 2, 0)],
    })
    engine.set(1, 'rate', rate)
    engine.set(1, 'depth', 1)
    engine.set(1, 'mix', 0.5)
    const input = Float64Array.from({ length: 4 * period }, (_, i) =>
      0.25 * Math.sin(2 * Math.PI * Math.round(period / 50) * i / period))
    const [out] = render(engine, input)
    const rms = start => Math.sqrt(out.subarray(start, start + 100)
      .reduce((sum, value) => sum + value * value, 0) / 100)
    const samples = Array.from({ length: 12 }, (_, i) => Math.round(period * (2 + i / 12)))
    const first = samples.map(rms)
    assert.ok(Math.max(...first) - Math.min(...first) > 0.03)
    assert.ok(samples.every((frame, i) => Math.abs(rms(frame + period) - first[i]) < 0.003))
  }
  amplitude(1, 1200) // 40 Hz
  amplitude(0.5, Math.round(sampleRate / 5.4))
})

function samplerEngine(options, sample) {
  return createEngine({
    modules: [module(1), module(102, options), module(2)],
    connections: [connection(1, 10, 2, 0), connection(1, 11, 2, 1),
      ...(options[0] ? [connection(0, 0, 1, 0), connection(0, 1, 1, 1)] : [])],
  }, { samples: { 1: sample } })
}

test('Sampler records stereo and plays a triggered sample forward and in reverse', () => {
  const engine = samplerEngine([1, 0, 1, 1])
  engine.set(1, 'record', 1)
  const left = Float64Array.of(0.25, 0.5, -0.25), right = Float64Array.of(0, -0.5, 1)
  assert.deepEqual([...render(engine, left, right)[0]], [0, 0, 0])
  engine.set(1, 'record', 0)
  engine.set(1, 'sample_playback', 1)
  assert.deepEqual(render(engine, new Float64Array(1)).map(x => [...x]), [[0.25], [0]])
  engine.set(1, 'sample_playback', 0)
  assert.deepEqual(render(engine, new Float64Array(3)).map(x => [...x]), [[0.5, -0.25, 0], [-0.5, 1, 0]])
  engine.set(1, 'direction', 1)
  engine.set(1, 'sample_playback', 1)
  assert.deepEqual(render(engine, new Float64Array(4)).map(x => [...x]), [[-0.25, 0.5, 0.25, 0], [1, -0.5, 0, 0]])
})

test('Sampler overdub and punch-in preserve sample length', () => {
  for (const [mode, first] of [[2, 0.75], [3, 0.5]]) {
    const engine = samplerEngine([mode, 1], { left: [0.25, 0.25] })
    engine.set(1, 'sample_playback', 1)
    engine.set(1, 'record', 1)
    assert.deepEqual([...render(engine, Float64Array.of(0.5))[0]], [first])
    engine.set(1, 'record', 0)
    assert.deepEqual([...render(engine, new Float64Array(3))[0]], [0.25, 0, 0])
    engine.set(1, 'sample_playback', 0)
    render(engine, new Float64Array(1))
    engine.set(1, 'sample_playback', 1)
    assert.deepEqual([...render(engine, new Float64Array(3))[0]], [first, 0.25, 0])
  }
})

test('editor can place and reload each new module for audition', () => {
  const patch = newPatch('Module smoke')
  for (const [index, id] of [102, 105, 106, 107, 55, 62, 84].entries())
    patch.addModule(id, { position: [0, 6, 9, 15, 21, 23, 25][index] })
  assert.deepEqual(patch.validate(), [])
  const engine = createEngine(decodePatch(encodeBinary(patch.patch)))
  assert.deepEqual(engine.unsupported, [])
  assert.deepEqual(render(engine, new Float64Array(1)).map(x => [...x]), [[0], [0]])
})
