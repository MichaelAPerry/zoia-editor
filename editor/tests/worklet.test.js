import assert from 'node:assert/strict'
import test from 'node:test'
import { newPatch } from '../core/model.js'

let registration
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.messages = []
    this.port = { postMessage: message => this.messages.push(message) }
  }
}
globalThis.registerProcessor = (name, processor) => { registration = { name, processor } }
const { ZoiaProcessor, PROCESSOR_NAME } = await import('../core/worklet.js')

function graph({ button, gain = 65535 } = {}) {
  const model = newPatch('Worklet')
  const input = model.addModule(1, { position: 0 })
  const vca = model.addModule(7, { position: 8, options: { channels: 'stereo' } })
  const output = model.addModule(2, { position: 16 })
  model.connect([input, 0], [vca, 'audio_in_1'])
  model.connect([input, 1], [vca, 'audio_in_2'])
  model.connect([vca, 'audio_out_1'], [output, 0])
  model.connect([vca, 'audio_out_2'], [output, 1])
  model.setParam(vca, 'level_control', gain)
  if (button) {
    const index = model.addModule(button, { position: 24 })
    model.connect([index, 'cv_output'], [vca, 'level_control'])
  }
  return model.patch
}

function send(processor, data) {
  processor.port.onmessage({ data })
  return processor.messages.at(-1)
}

function render(processor, { left = 0.25, right = 0.5, mono = false, frames = 128 } = {}) {
  const input = [new Float32Array(frames).fill(left)]
  if (!mono) input.push(new Float32Array(frames).fill(right))
  const output = [new Float32Array(frames), new Float32Array(frames)]
  assert.equal(processor.process([input], [output]), true)
  return output
}

test('worklet registers and processes two 64-frame blocks per 128-frame render', () => {
  assert.deepEqual(registration, { name: PROCESSOR_NAME, processor: ZoiaProcessor })
  const processor = new ZoiaProcessor({ processorOptions: { fadeFrames: 0 } })
  assert.equal(send(processor, { type: 'loadPatch', id: 1, patch: graph() }).id, 1)
  const [left, right] = render(processor)
  assert.ok(left.every(value => value === 0.25))
  assert.ok(right.every(value => value === 0.5))
  const meters = send(processor, { type: 'getMeters' })
  assert.deepEqual(meters.peak, [0.25, 0.5])
  assert.equal(meters.cpuMs.length, 2)
  assert.ok(meters.cpuMs.every(ms => Number.isFinite(ms) && ms >= 0))
  assert.ok(render(processor, { mono: true, frames: 70 })[1].every(value => value === 0.25))
  const partial = send(processor, { type: 'getMeters' })
  assert.equal(partial.dspLoad, partial.cpuMs.reduce((sum, ms) => sum + ms, 0) * 48000 / (70 * 10))
})

test('live parameters, both button types, reset and rejected loads', () => {
  for (const button of [15, 44]) {
    const processor = new ZoiaProcessor({ processorOptions: { fadeFrames: 0 } })
    assert.equal(send(processor, { type: 'loadPatch', patch: graph({ button, gain: 0 }) }).type, 'ok')
    assert.equal(render(processor)[0][0], 0)
    assert.equal(send(processor, { type: 'setState', module: 3, state: true }).type, 'ok')
    assert.equal(render(processor)[0][127], 0.25)
    send(processor, { type: 'setState', module: 3, state: false })
    send(processor, { type: 'setParam', module: 1, block: 2, raw: 65535 })
    assert.equal(render(processor)[0][127], 0.25)
    assert.equal(send(processor, { type: 'loadPatch', patch: {} }).type, 'error')
    assert.equal(render(processor)[0][127], 0.25)
    send(processor, { type: 'reset' })
    assert.equal(render(processor)[0][127], 0)
  }
})

test('crossfade preserves boundaries and queues only the latest rapid swap', () => {
  const processor = new ZoiaProcessor({ processorOptions: { fadeFrames: 128 } })
  send(processor, { type: 'loadPatch', patch: graph() })
  assert.equal(render(processor)[0][127], 0.25)
  send(processor, { type: 'loadPatch', patch: graph({ gain: 0 }) })
  const [half] = render(processor, { frames: 64 })
  assert.equal(half[0], 0.25)
  assert.ok(half[63] > 0 && half[63] < 0.25)
  send(processor, { type: 'loadPatch', patch: graph() })
  send(processor, { type: 'loadPatch', patch: graph({ gain: 0 }) })
  send(processor, { type: 'setParam', module: 1, block: 'level_control', raw: 32768 })
  const [rest] = render(processor)
  assert.equal(rest[63], 0)
  assert.equal(rest[64], 0)
  const [last] = render(processor)
  assert.ok(Math.abs(last[63] - 0.125) < 0.00001)
  assert.equal(last[63], last[64])
})
