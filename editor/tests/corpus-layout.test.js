import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { corpusFiles, corpusIndex } from '../../sim/patch-files.mjs'
import { decodePatch } from '../core/encode.js'
import { fixedHardwarePad, gridFootprint, GRID_SIZE, moduleBlocks, validatePatch } from '../core/model.js'
import { moduleWidth } from '../core/modules.js'
import { pagePads } from '../ui/view.js'

test('all indexed corpus patches fit their saved grid without placement errors', () => {
  const files = corpusFiles()
  assert.equal(files.length, corpusIndex().length)
  for (const path of files) {
    const patch = decodePatch(readFileSync(path))
    assert.equal(patch.decode_error, undefined, path)
    const pages = new Map()
    for (const record of patch.modules ?? []) {
      const span = gridFootprint(patch, record)
      if (fixedHardwarePad(record)) {
        assert.equal(span, 0)
        continue
      }
      const occupied = pages.get(record.page) ?? new Set()
      assert.ok(span > 0 && span <= moduleWidth(record), `${path}: ${record.type}`)
      for (let slot = record.position; slot < record.position + span; slot++) {
        assert.ok(slot >= 0 && slot < GRID_SIZE && !occupied.has(slot), `${path}: page ${record.page}, pad ${slot}`)
        occupied.add(slot)
      }
      pages.set(record.page, occupied)
    }
    assert.deepEqual(validatePatch(patch).filter(issue => /placement/.test(issue.message)), [], path)
    if (path.includes('Fading_Dream1_1')) {
      for (const index of [0, 1, 4, 5, 6, 7]) {
        const record = patch.modules[index]
        assert.equal(moduleWidth(record), 1)
        if (record.type_id === 45) assert.deepEqual(moduleBlocks(record).map(block => block.index), [0, 1])
        const [cell] = pagePads(patch, record.page)[record.position]
        assert.equal(cell.index, index)
        assert.equal(cell.blocks.length, moduleBlocks(record).length)
      }
    }
  }
})
