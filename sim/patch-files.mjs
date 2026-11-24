import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCorpus } from '../editor/ui/logic.js'
import { decodePatch } from './decode.mjs'

const corpus = fileURLToPath(new URL('../corpus/', import.meta.url))
export const corpusFiles = () => readdirSync(corpus).filter(name => name.endsWith('.bin'))
  .sort().map(name => join(corpus, name))

export const corpusIndex = () => parseCorpus(readFileSync(join(corpus, 'INDEX.csv'), 'utf8'))

export function decodeFiles(paths) {
  return paths.map(path => {
    try {
      return decodePatch(readFileSync(path))
    } catch (error) {
      return { decode_error: error.message }
    }
  })
}
