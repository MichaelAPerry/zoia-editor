import { closeSync, existsSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { createEngine, sampleRate } from './engine/index.mjs'
import { fillTestSignal } from './signal.mjs'
import { decodeWav, floatWavHeader } from './wav.mjs'

const usage = 'node sim/render.mjs patch.json [--in input.wav] --out out.wav [--seconds N] [--bpm N] [--cc seconds:channel:controller:value] [--set "module:param=value"]'

function render() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      in: { type: 'string' }, out: { type: 'string' }, seconds: { type: 'string' }, bpm: { type: 'string' },
      cc: { type: 'string', multiple: true },
      set: { type: 'string', multiple: true }, help: { type: 'boolean' },
    },
  })
  if (values.help) {
    console.log(usage)
    return
  }
  if (positionals.length !== 1 || !values.out) throw Error(usage)
  const patch = JSON.parse(readFileSync(positionals[0], 'utf8'))
  const engine = createEngine(patch, { bpm: Number(values.bpm ?? 0), acCoupledOutput: true })
  for (const override of values.set ?? []) {
    const match = /^(.+):([^:=]+)=([^=]+)$/.exec(override)
    if (!match || !match[3].trim()) throw Error(`Invalid override "${override}"`)
    engine.set(match[1], match[2], Number(match[3]))
  }
  const input = values.in && decodeWav(readFileSync(values.in))
  const seconds = values.seconds === undefined ? (input ? input.left.length / sampleRate : 4) : Number(values.seconds)
  const frames = Math.round(seconds * sampleRate)
  if (!Number.isSafeInteger(frames) || frames <= 0) throw Error('Specify a positive render duration')
  const events = (values.cc ?? []).map(spec => {
    const match = /^(\d+(?:\.\d+)?):(\d+):(\d+):(\d+)$/.exec(spec)
    if (!match) throw Error(`Invalid MIDI CC event "${spec}"`)
    const [time, channel, controller, value] = match.slice(1).map(Number)
    const frame = Math.round(time * sampleRate)
    if (frame >= frames || channel < 1 || channel > 16 || controller > 127 || value > 127)
      throw Error(`MIDI CC event out of range "${spec}"`)
    return { frame, channel, controller, value }
  }).sort((a, b) => a.frame - b.frame)
  let nextEvent = 0
  const header = floatWavHeader(frames)
  if (existsSync(values.out) && [positionals[0], values.in].some(path =>
    path && realpathSync(path) === realpathSync(values.out))) throw Error('Output must be separate from input files')
  console.log(`Unsupported modules: ${engine.unsupported.join(', ') || 'none'}`)
  if (engine.issues.length) console.warn(engine.issues.join('\n'))
  const block = engine.blockSize
  const l = new Float64Array(block), r = new Float64Array(block)
  const outL = new Float64Array(block), outR = new Float64Array(block)
  const encoded = Buffer.alloc(block * 8)
  const peak = [0, 0], squares = [0, 0], sums = [0, 0]
  const fd = openSync(values.out, 'w')
  const write = bytes => {
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
  }
  try {
    write(header)
    for (let offset = 0; offset < frames;) {
      while (events[nextEvent]?.frame === offset) {
        const { channel, controller, value } = events[nextEvent++]
        engine.sendMidiCC(channel, controller, value)
      }
      const n = Math.min(block, (events[nextEvent]?.frame ?? frames) - offset)
      if (input) {
        l.fill(0)
        r.fill(0)
        l.set(input.left.subarray(offset, offset + n))
        r.set((input.right ?? input.left).subarray(offset, offset + n))
      } else fillTestSignal(l.subarray(0, n), r.subarray(0, n), offset)
      engine.processBlock(l, r, outL.subarray(0, n), outR.subarray(0, n))
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < 2; c++) {
          const x = Math.fround((c === 0 ? outL : outR)[i])
          if (!Number.isFinite(x)) throw Error(`Non-finite output at frame ${offset + i}`)
          peak[c] = Math.max(peak[c], Math.abs(x))
          sums[c] += x
          squares[c] += x * x
          encoded.writeFloatLE(x, i * 8 + c * 4)
        }
      }
      write(encoded.subarray(0, n * 8))
      offset += n
    }
  } finally {
    closeSync(fd)
  }
  for (let c = 0; c < 2; c++) {
    console.log(`${c === 0 ? 'L' : 'R'} peak ${peak[c].toFixed(6)}  RMS ${Math.sqrt(squares[c] / frames).toFixed(6)}  mean ${(sums[c] / frames).toFixed(6)}`)
  }
}

try {
  render()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
