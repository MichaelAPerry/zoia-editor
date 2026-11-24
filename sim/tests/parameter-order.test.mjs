import assert from 'node:assert/strict'
import test from 'node:test'
import { layout } from '../engine/layout.mjs'
import { moduleIndex } from '../engine/module-index.mjs'
import { corpusFiles, corpusIndex, decodeFiles } from '../patch-files.mjs'

test('packed knob order agrees with modulation evidence across the patch corpus', t => {
  const patches = decodeFiles(corpusFiles())
  assert.equal(patches.length, corpusIndex().length)
  const types = new Set()
  const evidence = new Set()
  const plate = { mix: [0, 0], decay_time: [0, 0] }

  for (const patch of patches) {
    assert.equal(patch.decode_error, undefined)
    const incoming = new Map()
    for (const { destination: [module, block] } of patch.connections ?? []) {
      if (!incoming.has(module)) incoming.set(module, new Set())
      incoming.get(module).add(block)
    }
    for (const [index, record] of (patch.modules ?? []).entries()) {
      const id = record.type_id
      types.add(id)
      const { active, knobNames } = layout(record)
      assert.deepEqual(new Set(knobNames), new Set(active.filter(block => block[3]).map(block => block[0])))

      for (const [name, block] of active) {
        const slot = knobNames.indexOf(name)
        if (slot < 0 || !incoming.get(index)?.has(block)) continue
        evidence.add(id)

        if (id === 25 && Object.hasOwn(plate, name)) {
          if (record.parameters[slot] === 0) plate[name][0]++
          if (record.parameters[1 - slot] === 0) plate[name][1]++
        }
      }
    }
  }

  for (const id of Object.keys(moduleIndex).map(Number)) {
    const { active, knobNames } = layout({ type_id: id })
    assert.deepEqual(new Set(knobNames), new Set(active.filter(block => block[3]).map(block => block[0])))
  }

  assert.deepEqual(layout({ type_id: 25 }).knobNames, ['mix', 'decay_time', 'low_eq', 'high_eq'])
  for (const [name, [packed, swapped]] of Object.entries(plate)) {
    assert.ok(packed > swapped, `Plate Reverb ${name}: ${packed} packed matches, ${swapped} swapped`)
  }
  t.diagnostic(`Checked ${types.size} corpus types, with connected knob evidence for ${evidence.size}`)
})
