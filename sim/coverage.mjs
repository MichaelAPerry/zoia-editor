import { basename } from 'node:path'
import { corpusFiles, decodeFiles } from './patch-files.mjs'
import { unsupportedModules } from './engine/index.mjs'

const paths = corpusFiles()
const patches = decodeFiles(paths)
let supported = 0, blank = 0
for (const [index, patch] of patches.entries()) {
  if (patch.empty) blank++
  const missing = unsupportedModules(patch)
  if (!patch.empty && !missing.length) supported++
  console.log(`${basename(paths[index])}\t${patch.empty ? 'blank slot' : missing.join(', ') || 'fully supported'}`)
}
console.log(`${supported}/${patches.length} files fully supported by module type (${blank} blank slots)`)
