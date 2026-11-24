import { createEngine, defaultBlockSize, sampleRate as engineRate } from '../../sim/engine/index.mjs'
import { parameterBlock, RAW_MAX } from './modules.js'

export const PROCESSOR_NAME = 'zoia-simulator'
const blockSize = defaultBlockSize
const now = () => globalThis.performance?.now() ?? Date.now()

export class ZoiaProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super()
    if (globalThis.sampleRate !== undefined && globalThis.sampleRate !== engineRate) {
      throw new Error(`ZOIA requires a ${engineRate} Hz AudioContext`)
    }
    const { fadeFrames = 1024, ...engineOptions } = options.processorOptions ?? {}
    if (!Number.isSafeInteger(fadeFrames) || fadeFrames < 0) throw new RangeError('Invalid fadeFrames')
    this.fadeFrames = fadeFrames
    this.fadeProgress = fadeFrames
    this.engineOptions = { ...engineOptions, blockSize }
    this.patch = { empty: true }
    this.current = createEngine(this.patch, this.engineOptions)
    this.previous = null
    this.pending = null
    this.nextOutput = [new Float32Array(blockSize), new Float32Array(blockSize)]
    this.oldOutput = [new Float32Array(blockSize), new Float32Array(blockSize)]
    this.peak = [0, 0]
    this.cpuMs = []
    this.cpuFrames = 0
    this.port.onmessage = ({ data }) => this.handleMessage(data)
  }

  #swap(engine) {
    if (this.previous) {
      this.pending = engine
    } else {
      this.previous = this.fadeFrames ? this.current : null
      this.current = engine
      this.fadeProgress = 0
    }
  }

  handleMessage(message) {
    const { type, id } = message ?? {}
    const respond = (type, payload) => this.port.postMessage({ type, id, ...payload })
    try {
      const target = this.pending ?? this.current
      switch (type) {
        case 'loadPatch':
        case 'reset': {
          const patch = type === 'loadPatch' ? message.patch : this.patch
          const engine = createEngine(patch, this.engineOptions)
          this.patch = patch
          this.#swap(engine)
          respond('ok', { command: type, unsupported: engine.unsupported, issues: engine.issues })
          break
        }
        case 'setParam': {
          const { module, block, raw } = message
          const record = Number.isInteger(module) ? this.patch.modules?.[module] : undefined
          if (!record) throw new RangeError('Expected an existing numeric module index')
          if (!Number.isInteger(raw) || raw < 0 || raw > RAW_MAX) throw new RangeError('Invalid raw parameter')
          target.set(module, parameterBlock(record, block).name, raw / RAW_MAX)
          respond('ok', { command: type })
          break
        }
        case 'setState': {
          const { module, state } = message
          if (![true, false, 0, 1].includes(state)) throw new TypeError('State must be boolean, 0 or 1')
          target.set(module, 'state', Number(state))
          respond('ok', { command: type })
          break
        }
        case 'getMeters': {
          const elapsed = this.cpuMs.reduce((sum, block) => sum + block, 0)
          const dspLoad = this.cpuFrames ? elapsed * engineRate / (this.cpuFrames * 10) : null
          respond('meters', { peak: [...this.peak], cpuMs: [...this.cpuMs], dspLoad })
          break
        }
        default:
          throw new Error(`Unknown command: ${type}`)
      }
    } catch (error) {
      respond('error', { command: type, message: error.message })
    }
  }

  process(inputs, outputs) {
    const input = inputs[0]
    const output = outputs[0]
    if (!output?.length) return true
    for (let channel = 2; channel < output.length; channel++) output[channel].fill(0)
    this.peak.fill(0)
    this.cpuMs.length = 0
    this.cpuFrames = output[0].length
    for (let offset = 0; offset < output[0].length; offset += blockSize) {
      const start = now()
      const end = Math.min(offset + blockSize, output[0].length)
      const frames = end - offset
      const left = input?.[0]?.subarray(offset, end)
      const right = input?.[1]?.subarray(offset, end)
      const [nextL, nextR] = this.nextOutput
      const [oldL, oldR] = this.oldOutput
      this.current.processBlock(left, right,
        frames === blockSize ? nextL : nextL.subarray(0, frames),
        frames === blockSize ? nextR : nextR.subarray(0, frames))
      if (this.previous) {
        this.previous.processBlock(left, right,
          frames === blockSize ? oldL : oldL.subarray(0, frames),
          frames === blockSize ? oldR : oldR.subarray(0, frames))
        for (let i = 0; i < frames && this.fadeProgress < this.fadeFrames; i++) {
          const mix = this.fadeFrames === 1 ? 1 : this.fadeProgress / (this.fadeFrames - 1)
          nextL[i] = oldL[i] + (nextL[i] - oldL[i]) * mix
          nextR[i] = oldR[i] + (nextR[i] - oldR[i]) * mix
          this.fadeProgress++
        }
        if (this.fadeProgress === this.fadeFrames) {
          this.previous = null
          if (this.pending) {
            const engine = this.pending
            this.pending = null
            this.#swap(engine)
          }
        }
      }
      output[0].set(frames === blockSize ? nextL : nextL.subarray(0, frames), offset)
      output[1]?.set(frames === blockSize ? nextR : nextR.subarray(0, frames), offset)
      for (let i = 0; i < frames; i++) {
        this.peak[0] = Math.max(this.peak[0], Math.abs(nextL[i]))
        if (output[1]) this.peak[1] = Math.max(this.peak[1], Math.abs(nextR[i]))
      }
      this.cpuMs.push(now() - start)
    }
    return true
  }
}

registerProcessor(PROCESSOR_NAME, ZoiaProcessor)
