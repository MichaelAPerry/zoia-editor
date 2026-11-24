import assert from 'node:assert/strict'
import test from 'node:test'
import { layout } from '../engine/layout.mjs'
import { moduleIndex } from '../engine/module-index.mjs'
import { corpusFiles, corpusIndex, decodeFiles } from '../patch-files.mjs'

test('packed knob order agrees with modulation evidence across the patch corpus', t => {
  const patches = decodeFiles(corpusFiles())
  assert.equal(patches.length, corpusIndex().length)
  const types = new Set()
  const evidence = new Map()
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
        const tally = evidence.get(id) ?? { total: 0, zeroOrUnused: 0 }
        evidence.set(id, tally)
        tally.total++
        if (!record.parameters[slot]) tally.zeroOrUnused++

        if (id === 25 && Object.hasOwn(plate, name)) {
          if (record.parameters[slot] === 0) plate[name][0]++
          if (record.parameters[1 - slot] === 0) plate[name][1]++
        }
      }
    }
  }

  assert.equal(types.size, 100)
  assert.equal(evidence.size, 71)
  for (const id of Object.keys(moduleIndex).map(Number)) {
    const { active, knobNames } = layout({ type_id: id })
    assert.deepEqual(new Set(knobNames), new Set(active.filter(block => block[3]).map(block => block[0])))
  }

  // Some CV inputs use a saved offset (e.g. Looper speed) or are normally
  // connected together. Track zero/unused matches per type so that a strong
  // result for a high-volume type cannot hide a regression in another one.
  const matches = {
    0: 300, 2: 2, 3: 22, 4: 467, 5: 332, 6: 843, 7: 587, 9: 17,
    10: 435, 11: 16, 12: 42, 13: 113, 14: 236, 16: 1, 17: 392, 18: 2,
    19: 110, 22: 2367, 23: 7, 24: 128, 25: 39, 28: 29, 29: 6,
    30: 650, 31: 1555, 32: 265, 33: 57, 34: 157, 36: 1, 37: 6, 39: 200,
    40: 5, 41: 1, 42: 2, 43: 72, 45: 76, 46: 66, 47: 28, 48: 182, 49: 128,
    50: 389, 51: 23, 52: 100, 53: 7, 56: 91, 57: 88, 59: 0, 60: 6, 61: 2,
    64: 78, 66: 10, 67: 2, 69: 1, 70: 6, 71: 8, 73: 1, 74: 10,
    75: 7, 76: 4, 77: 137, 78: 84, 79: 41, 80: 1, 81: 337, 83: 166,
    87: 19, 99: 31, 100: 27, 101: 25, 103: 1, 104: 25,
  }
  assert.equal(Object.keys(matches).length, evidence.size)
  for (const [id, minimum] of Object.entries(matches)) {
    const tally = evidence.get(Number(id))
    assert.ok(tally.zeroOrUnused >= minimum,
      `${moduleIndex[id][0]} matched ${tally.zeroOrUnused} of ${tally.total} connected controls, expected at least ${minimum}`)
  }
  assert.deepEqual(layout({ type_id: 25 }).knobNames, ['mix', 'decay_time', 'low_eq', 'high_eq'])
  assert.deepEqual(plate, { mix: [16, 14], decay_time: [23, 15] })
  t.diagnostic(`Checked ${types.size} corpus types, with connected knob evidence for ${evidence.size}`)
})
