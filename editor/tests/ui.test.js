import assert from 'node:assert/strict'
import test from 'node:test'
import { decodePatch, encodePatch } from '../core/encode.js'
import { moduleTypes, newPatch, PatchModel } from '../core/model.js'
import { oledModel } from '../ui/display.js'
import { padLight } from '../ui/view.js'
import { cableCurve, firstOccupiedPage, gridHit, groupModules, padAnchor, parseCorpus, pcmWav, stubEnd } from '../ui/logic.js'

test('grid hit testing scales to client coordinates and excludes its outside edges', () => {
  const rect = { left: 15, top: 20, width: 400, height: 250 }
  assert.equal(gridHit(rect, 15, 20), 0)
  assert.equal(gridHit(rect, 64.9, 69.9), 0)
  assert.equal(gridHit(rect, 65, 70), 9)
  assert.equal(gridHit(rect, 414.99, 269.99), 39)
  assert.equal(gridHit(rect, 415, 30), null)
  assert.equal(gridHit(rect, 70, 270), null)
  assert.equal(gridHit(rect, 14.99, 35), null)
  assert.equal(gridHit(rect, 70, 19.99), null)
  assert.equal(gridHit({ ...rect, width: 0 }, 15, 20), null)
})

test('cables anchor to the correct pads and make visible same-row curves and off-page stubs', () => {
  const source = padAnchor(0, 'out')
  const destination = padAnchor(1, 'in')
  assert.deepEqual(source, { x: 70, y: 78 })
  assert.deepEqual(padAnchor(8, 'in'), { x: 30, y: 178 })
  assert.equal(padAnchor(40, 'in'), null)
  assert.equal(cableCurve(source, destination), 'M 70 78 Q 70 100 76 100 H 124 Q 130 100 130 78')
  assert.match(cableCurve(destination, padAnchor(16, 'in')), /^M 130 78 Q .* 30 278$/)
  assert.deepEqual(stubEnd(padAnchor(39, 'out'), 'out', 3), { x: 791, y: 495 })
  assert.deepEqual(stubEnd(padAnchor(32, 'in'), 'in', 0), { x: 9, y: 486 })
})

test('opening starts on the earliest occupied page', () => {
  assert.equal(firstOccupiedPage({ modules: [{ page: 3 }, { page: 1 }, { page: 2 }] }), 1)
  assert.equal(firstOccupiedPage({ modules: [{ page: 3 }, {}] }), 0)
  assert.equal(firstOccupiedPage({ empty: true }), 0)
})

test('cable curves stay inside the grid even on the outer pads', () => {
  for (let from = 0; from < 40; from++) {
    for (let to = 0; to < 40; to++) {
      const path = cableCurve(padAnchor(from, 'out'), padAnchor(to, 'in'))
      const commands = path.matchAll(/([MQHV]) ([\d.]+)(?: ([\d.]+))?(?: ([\d.]+) ([\d.]+))?/g)
      for (const [, command, a, b, c, d] of commands) {
        if (command !== 'V') assert.ok(+a >= 0 && +a <= 800, path)
        if (command === 'V') assert.ok(+a >= 0 && +a <= 500, path)
        if (b !== undefined) assert.ok(+b >= 0 && +b <= 500, path)
        if (c !== undefined) assert.ok(+c >= 0 && +c <= 800 && +d >= 0 && +d <= 500, path)
      }
    }
  }
})

test('palette groups cover the full catalog once and remain stable across searches', () => {
  const groups = groupModules(moduleTypes)
  assert.equal(groups.length, 10)
  const ids = groups.flatMap(group => group.types.map(type => type.id)).sort((a, b) => a - b)
  assert.deepEqual(ids, moduleTypes.map(type => type.id).sort((a, b) => a - b))
  assert.deepEqual(groupModules(moduleTypes, '  reverse DELAY ').map(group =>
    [group.label, group.index, group.types.map(type => type.name)]),
  [['Effects · Delay', 1, ['Reverse Delay']]])
  assert(groupModules(moduleTypes, 'reverb').some(group => group.types.some(type => type.name === 'Ghostverb')))
  assert.equal(groupModules(moduleTypes, 'no such type').length, 0)
})

test('corpus CSV handles quoted commas, escapes, newlines, BOM and CRLF', () => {
  const csv = '\uFEFFfile,title,tags\r\na.bin,"Title, with ""quotes""","two\nlines"\r\nb.bin,Other,'
  assert.deepEqual(parseCorpus(csv), [
    { file: 'a.bin', title: 'Title, with "quotes"', tags: 'two\nlines' },
    { file: 'b.bin', title: 'Other', tags: '' },
  ])
})

test('WAV writer emits little-endian interleaved 16-bit PCM with full scale clipping', () => {
  const stereo = pcmWav([Float32Array.of(-2, .5, 0), Float32Array.of(1.5, -.5, .25)], 48000)
  const wav = new DataView(stereo)
  assert.equal(Buffer.from(stereo).toString('ascii', 0, 4), 'RIFF')
  assert.equal(Buffer.from(stereo).toString('ascii', 8, 16), 'WAVEfmt ')
  assert.equal(wav.getUint32(4, true), stereo.byteLength - 8)
  assert.equal(wav.getUint16(20, true), 1)
  assert.equal(wav.getUint16(22, true), 2)
  assert.equal(wav.getUint32(24, true), 48000)
  assert.equal(wav.getUint32(28, true), 192000)
  assert.equal(wav.getUint16(32, true), 4)
  assert.equal(wav.getUint16(34, true), 16)
  assert.equal(Buffer.from(stereo).toString('ascii', 36, 40), 'data')
  assert.equal(wav.getUint32(40, true), 12)
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => wav.getInt16(44 + i * 2, true)),
    [-32768, 32767, 16384, -16384, 0, 8192])
  assert.equal(pcmWav([[0]], 22050).byteLength, 46)
  assert.throws(() => pcmWav([[0], [0, 0]], 48000), /equally sized/)
})

test('recording worklet clips a final partial block and sends independent stereo channels', async () => {
  let Recorder
  const sent = []
  globalThis.AudioWorkletProcessor = class {
    port = { postMessage: (data, transfers) => sent.push(structuredClone(data, { transfer: transfers })) }
  }
  globalThis.registerProcessor = (name, type) => {
    assert.equal(name, 'zoia-wav-capture')
    Recorder = type
  }
  try {
    await import('../ui/recorder.js')
    const recorder = new Recorder()
    assert.equal(recorder.process([[]]), true)
    recorder.port.onmessage({ data: { frames: 3 } })
    recorder.process([[Float32Array.of(1, 2), Float32Array.of(3, 4)]])
    assert.equal(sent.length, 0)
    recorder.process([[Float32Array.of(5, 6), Float32Array.of(7, 8)]])
    assert.deepEqual(sent, [[Float32Array.of(1, 2, 5), Float32Array.of(3, 4, 7)]])
    recorder.process([[Float32Array.of(9), Float32Array.of(10)]])
    assert.equal(sent.length, 1)
  } finally {
    delete globalThis.AudioWorkletProcessor
    delete globalThis.registerProcessor
  }
})

test('names, colours and cable strength preserve model history and binary round trips', () => {
  const model = newPatch('Before')
  const input = model.addModule('Audio Input', { position: 0 })
  const output = model.addModule('Audio Output', { position: 8 })
  const cable = model.connect([input, 'output_L'], [output, 'input_L'])
  const baseline = model.patch
  model.renamePatch('After')
  model.renameModule(input, 'In')
  model.setModuleColor(input, 15)
  assert.equal(model.setConnectionStrength(cable, { db: -6 }), 9400)
  const after = model.patch
  assert.deepEqual(after.connections[cable], { ...baseline.connections[cable], strength: 9400 })
  const decoded = decodePatch(encodePatch(after))
  assert.equal(decoded.name, 'After')
  assert.equal(decoded.modules[input].name, 'In')
  assert.equal(decoded.colors[input], 15)
  assert.equal(decoded.connections[cable].strength, 9400)
  for (let i = 0; i < 4; i++) assert(model.undo())
  assert.deepEqual(model.patch, baseline)
  for (let i = 0; i < 4; i++) assert(model.redo())
  assert.deepEqual(model.patch, after)
  assert.throws(() => model.renameModule(input, 'Non-ASCII 🐈'), /16 ASCII/)
  assert.deepEqual(model.patch, after)

  const legacy = new PatchModel({ ...baseline, colors: [], starred: [{ connection: cable, midi_cc: 22 }] })
  legacy.setModuleColor(input, 7)
  assert.equal(legacy.patch.modules[input].header_color, 7)
  assert.throws(() => legacy.setModuleColor(input, 8), /between 1 and 7/)
  legacy.setConnectionStrength(cable, { db: -Infinity })
  assert.equal(legacy.patch.connections[cable].strength, 0)
  assert.deepEqual(legacy.patch.starred, [{ connection: cable, midi_cc: 22 }])
})

test('OLED model follows the manual: patch screen, parameter screen and connection screen', () => {
  const base = { patch: { name: 'Wet Delay' }, slot: 7, page: 1, pageCount: 3, pageLabel: 'Main', cpu: 'CPU 12%' }
  assert.deepEqual(oledModel(base), {
    kind: 'patch', where: 'PG 2/3', title: 'Wet Delay', label: 'P007', lines: ['Main'], armed: undefined, cpu: 'CPU 12%',
  })
  const selected = { module: 'Delay', label: 'delay time', value: '400 ms', position: .25 }
  const param = oledModel({ ...base, selected })
  assert.equal(param.kind, 'param')
  assert.equal(param.title, 'Delay')
  assert.equal(param.value, '400 ms')
  assert.equal(param.position, .25)
  const cable = oledModel({ ...base, selected, cable: { from: 'A', to: 'B', strength: '0 dB' } })
  assert.equal(cable.kind, 'cable')
  assert.deepEqual(cable.lines, ['A', 'B'])
})

test('lit pad colours stay readable: dark ink on bright keys, white ink on dim blue', () => {
  assert.equal(padLight('#ffffff', 1).ink, '#0a0a0a')
  assert.equal(padLight('#ffff00', 1).ink, '#0a0a0a')
  assert.equal(padLight('#0000ff', .55).ink, '#ffffff')
  assert.equal(padLight('#ff0000', 0).background, 'rgb(20,20,24)')
  assert.equal(padLight('#ff0000', 1).background, 'rgb(255,0,0)')
})
