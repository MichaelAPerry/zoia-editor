import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { decodePatch, encodePatch } from '../core/encode.js'
import { moduleBlocks, moduleTypes, newPatch, PatchModel, validatePatch } from '../core/model.js'
import { patchToYaml, yamlToPatch } from '../core/text.js'

const zoia = new URL('../../', import.meta.url)
const corpus = new URL('corpus/', zoia)
const files = readdirSync(corpus).filter(name => name.endsWith('.bin')).sort()
const readPatch = file => readFileSync(new URL(file, corpus))

function thru() {
  const model = newPatch('Edited thru')
  const input = model.addModule('Audio Input', { position: 0, name: 'In' })
  const vca = model.addModule('VCA', { position: 8, name: 'Gain', options: { channels: 'stereo' } })
  const output = model.addModule('Audio Output', { position: 16, name: 'Out', color: 13 })
  model.setParamDisplay(vca, 'level_control', 0)
  model.connect([input, 'output_L'], [vca, 'audio_in_1'])
  model.connect([input, 'output_R'], [vca, 'audio_in_2'])
  model.connect([vca, 'audio_out_1'], [output, 'input_L'], { db: -6 })
  model.connect([vca, 'audio_out_2'], [output, 'input_R'], { raw: 10000 })
  model.starParam(vca, 'level_control', 19)
  return model
}

test(`all ${files.length} corpus binaries survive JS decode and encode byte for byte`, () => {
  assert.ok(files.length)
  for (const file of files) {
    const input = readPatch(file)
    const patch = decodePatch(input)
    assert.ok(input.equals(encodePatch(patch)), file)
  }
})

test('JS and Python encode identical bytes for three edited patch documents', () => {
  const model = thru()
  const imported = new PatchModel(decodePatch(readPatch(files.find(file => file.includes('aetherverb_v1_0-1')))))
  imported.addPage('Edited')
  imported.renamePage(imported.pageCount - 1, 'Extra')
  const legacy = {
    name: 'Legacy',
    name_hex: '4c656761637900aa0000000000000000',
    pages: [{ name: 'FX' }],
    modules: [{ type_id: 7, position: 0, name: null, parameters: [10000], saved_data_hex: 'cafebabe' }],
    colors: [],
    starred: [{ connection: 0, reserved: 6, midi_cc: 127 }],
    payload_tail_hex: '01020304',
    padding_hex: '0102',
  }
  for (const patch of [model.patch, imported.patch, legacy]) {
    const result = spawnSync('python3', ['-B', '-c',
      'import json,sys,zoiacodec; sys.stdout.buffer.write(zoiacodec.encode(json.loads(sys.argv[1])))',
      JSON.stringify(patch)], { cwd: fileURLToPath(zoia), stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 })
    assert.equal(result.status, 0, result.stderr?.toString())
    assert.ok(result.stdout.equals(encodePatch(patch)), patch.name)
  }
})

test('text preserves sampled corpus bytes, empty slots and opaque imports', () => {
  const sample = files.filter((_, i) => i % 19 === 0)
  for (const file of sample) {
    const input = readPatch(file)
    assert.ok(input.equals(encodePatch(yamlToPatch(patchToYaml(decodePatch(input))))), file)
  }
  for (const patch of [
    { empty: true },
    { name: 'Opaque', module_count: 1, opaque_body_hex: '01000000', padding_hex: '5701' },
    { name: 'Tail', payload_tail_hex: '01020304', padding_hex: 'ffff' },
  ]) {
    const binary = encodePatch(patch)
    assert.deepEqual(encodePatch(yamlToPatch(patchToYaml(decodePatch(binary)))), binary)
  }
  const patch = thru().patch
  const text = patchToYaml(patch)
  assert.match(text, /In\.output_L -> Gain\.audio_in_1 = 10000/)
  assert.match(text, /knob level_control = 0 dB/)
  assert.equal(yamlToPatch(text.replace('0 dB', '-6 dB')).modules[1].parameters[0], 32845)
})

test('grid edits are atomic and undo/redo preserve colors, pages, cables and stars', () => {
  const model = thru()
  const original = model.patch
  assert.throws(() => model.moveModule(0, { position: 39 }), /overflow/)
  assert.throws(() => model.moveModule(0, { position: 10 }), /overlap/)
  assert.deepEqual(model.patch, original)
  const second = model.addPage('Second')
  model.moveModule(0, { page: second, position: 38 })
  model.renamePage(second, 'Inputs')
  const beforeDelete = model.patch
  const report = model.deletePage(0)
  assert.equal(report.droppedConnections.length, 4)
  assert.equal(report.droppedStars.length, 1)
  assert.deepEqual(model.patch.colors, [1])
  assert.deepEqual(model.patch.pages, [{ name: 'Inputs' }])
  assert.equal(model.patch.modules[0].page, 0)
  assert.equal(model.undo(), true)
  assert.deepEqual(model.patch, beforeDelete)
  assert.equal(model.redo(), true)
  assert.equal(model.patch.modules.length, 1)
  model.undo()
  model.renamePage(second, 'Front')
  assert.equal(model.canRedo, false)
  assert.deepEqual(model.validate(), [])
})

test('option edits keep fixed block identities, compact knobs and reindex connection stars', () => {
  const model = thru()
  const patch = model.patch
  patch.starred.push({ connection: 1, midi_cc: null }, { connection: 2, midi_cc: 3 })
  const imported = new PatchModel(patch)
  const report = imported.setOption(1, 'channels', '1in->1out')
  assert.deepEqual(report.droppedConnections.map(cable => cable.index), [1, 3])
  assert.deepEqual(report.droppedStars, [{ connection: 1, midi_cc: null }])
  assert.deepEqual(imported.patch.starred, [patch.starred[0], { connection: 1, midi_cc: 3 }])
  assert.equal(imported.patch.modules[1].parameters[0], 65535)
  assert.deepEqual(imported.blocks(1).map(block => block.index), [0, 2, 3])
  assert.deepEqual(imported.patch.connections[1].source, [1, 3])
  assert.deepEqual(imported.disconnect(0).droppedStars, [])
  assert.equal(imported.patch.starred[1].connection, 0)
  imported.unstarParam(1, 'level_control')
  assert.deepEqual(imported.deleteModule(1).droppedStars, [{ connection: 0, midi_cc: 3 }])

  const fx = newPatch()
  const env = fx.addModule('ADSR', { position: 0 })
  fx.setParam(env, 'attack', 347)
  fx.setOption(env, 'initial_delay', 'on')
  assert.equal(fx.patch.modules[env].parameters[2], 347)
  fx.starParam(env, 'delay')
  assert.equal(fx.setOption(env, 'initial_delay', 'off').droppedStars[0].block, 2)
  assert.equal(fx.patch.modules[env].parameters[1], 347)
})

test('optional endpoints follow the vendored layout rules without renumbering', () => {
  const model = newPatch()
  const pixel = model.addModule('Pixel', { position: 0 })
  assert.deepEqual(model.blocks(pixel).map(block => [block.name, block.index]), [['cv_in', 0]])
  model.setOption(pixel, 'control', 'audio')
  assert.deepEqual(model.blocks(pixel).map(block => [block.name, block.index]), [['audio_in', 1]])

  const sampler = model.addModule('Sampler', { position: 8 })
  assert.equal(model.blocks(sampler).length, 6)
  model.setOption(sampler, 'record', 'overdub')
  model.setOption(sampler, 'reverse_button', 'on')
  model.setOption(sampler, 'cv_outputs', 'on')
  assert.equal(model.blocks(sampler).length, 12)
  assert.equal(model.blocks(sampler).find(block => block.name === 'audio_out_L').index, 10)

  const delay = model.addModule('Reverse Delay', { position: 24 })
  assert.equal(model.blocks(delay).length, 6)
  model.setOption(delay, 'control', 'tap_tempo')
  assert.equal(model.blocks(delay).length, 7)
  assert.ok(model.blocks(delay).some(block => block.name === 'tap_ratio'))
  assert.ok(!model.blocks(delay).some(block => block.name === 'delay_time'))
})

test('metadata covers the module index and tapers handle ms, Hz, dB and percent', () => {
  const model = newPatch()
  const delay = model.addModule('Delay Line', { position: 0, options: { max_time: '2s' } })
  const filter = model.addModule('SV Filter', { position: 8 })
  const reverb = model.addModule('Reverb Lite', { position: 16 })
  const gate = model.addModule('Logic Gate', { position: 30, options: { operation: 'NOT' } })
  assert.equal(model.blocks(gate).length, 2)
  assert.equal(model.blocks(gate, { includeHidden: true }).length, 40)
  const delayBlock = model.blocks(delay).find(block => block.name === 'delay_time')
  const delayRaw = model.setParamDisplay(delay, 'delay_time', 500)
  assert.equal(delayBlock.units, 'ms')
  assert.equal(delayBlock.guessed, true)
  assert.ok(Math.abs(delayBlock.display(delayRaw) - 500) < 0.1)
  const hz = model.blocks(filter).find(block => block.name === 'frequency')
  assert.equal(hz.units, 'Hz')
  assert.ok(Math.abs(hz.display(model.setParamDisplay(filter, 'frequency', 880)) - 880) < 0.1)
  assert.equal(model.setParamDisplay(reverb, 'mix', 50), 32768)
  const vca = thru().blocks(1).find(block => block.name === 'level_control')
  assert.equal(vca.display(0), -Infinity)
  assert.equal(vca.units, 'dB')
  assert.equal(vca.guessed, false)
  const { names } = JSON.parse(readFileSync(new URL('zoiacodec/module_index.json', zoia), 'utf8'))
  assert.deepEqual(Object.fromEntries(moduleTypes.map(({ id, name }) => [id, name])), names)
  for (const { id } of moduleTypes) {
    const blocks = moduleBlocks({ type_id: id }, { includeHidden: true })
    assert.ok(blocks.length, id)
    assert.ok(blocks.every(block => block.name && block.kind && block.units && block.range.length === 2), id)
  }
})

test('validation reports invalid direction, mismatch, unknown types, overlaps, overflow and file size', () => {
  const model = thru()
  assert.throws(() => model.connect([0, 0], [1, 'audio_out_1']), /output to an input/)
  assert.throws(() => model.connect([1, 'audio_in_1'], [2, 0]), /output to an input/)
  assert.throws(() => model.connect([0, 0], [1, 'level_control']), /CV outputs connect to CV inputs/)
  const patch = model.patch
  patch.connections.push({ source: [0, 0], destination: [1, 2], strength: 10000 })
  patch.modules.push({ type_id: 9999, position: 0 }, { type_id: 1, position: 39 })
  patch.connections.push({ source: [0, 0], destination: [1, 3], strength: 10000 })
  patch.colors = []
  patch.padding_hex = 'aa'.repeat(32768)
  const issues = validatePatch(patch)
  for (const code of ['direction', 'signal-mismatch', 'unknown-module', 'overlap', 'overflow', 'binary-format']) {
    assert.ok(issues.some(issue => issue.code === code), code)
  }
  assert.equal(issues.find(issue => issue.code === 'signal-mismatch').severity, 'error')
})

test('encoder rejects wrong direction, crossed signals and disabled option blocks', () => {
  const patch = thru().patch
  patch.modules.push({ type_id: 5, position: 24 })
  patch.colors.push(1)
  for (const [source, destination, message] of [
    [[0, 0], [1, 3], /output to an input/],
    [[1, 0], [2, 0], /output to an input/],
    [[3, 3], [2, 0], /CV outputs connect to CV inputs/],
    [[0, 0], [1, 2], /audio outputs connect to audio inputs/i],
    [[3, 3], [2, 2], /active module jacks/],
  ]) {
    const cable = { source, destination, strength: 10000 }
    assert.throws(() => encodePatch({ ...patch, connections: [cable] }), message)
  }
  patch.modules[2].options = [1]
  assert.doesNotThrow(() => encodePatch({
    ...patch, connections: [{ source: [3, 3], destination: [2, 2], strength: 10000 }],
  }))
})

test('feedback and depth use percent in the editor while saved text keeps its original units', () => {
  const model = newPatch('Ratios')
  const index = model.addModule('Delay w/Mod', { position: 0 })
  for (const key of ['feedback', 'mod_depth', 'mix']) {
    const block = model.blocks(index).find(block => block.name === key)
    assert.equal(block.units, '%')
    assert.deepEqual(block.range, [0, 100])
    assert.equal(model.setParamDisplay(index, key, 50), 32768)
  }
  const source = patchToYaml(model.patch)
  assert.match(source, /knob feedback = -[.\d]+ dB/)
  assert.deepEqual(yamlToPatch(source).modules[index].parameters, model.patch.modules[index].parameters)
})
