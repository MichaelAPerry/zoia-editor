import { sampleRate } from './engine/index.mjs'

export function decodeWav(bytes) {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')
    throw Error('Expected a RIFF/WAVE file')
  let format, data
  const end = bytes.readUInt32LE(4) + 8
  if (end > bytes.length) throw Error('Truncated RIFF/WAVE file')
  for (let offset = 12; offset + 8 <= end;) {
    const name = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    if (start + size > end) throw Error(`Truncated WAV chunk ${name}`)
    if (name === 'fmt ' && !format) format = bytes.subarray(start, start + size)
    if (name === 'data' && !data) data = bytes.subarray(start, start + size)
    offset = start + size + (size & 1)
  }
  if (!format || format.length < 16 || !data) throw Error('WAV needs fmt and data chunks')
  let tag = format.readUInt16LE()
  const channels = format.readUInt16LE(2), rate = format.readUInt32LE(4)
  const align = format.readUInt16LE(12), bits = format.readUInt16LE(14)
  if (tag === 0xfffe && format.length >= 40 && format.readUInt16LE(16) >= 22
    && format.toString('hex', 26, 40) === '000000001000800000aa00389b71') tag = format.readUInt16LE(24)
  const pcm = tag === 1 && (bits === 16 || bits === 24)
  const floating = tag === 3 && (bits === 32 || bits === 64)
  if ((!pcm && !floating) || ![1, 2].includes(channels) || !rate || align !== channels * bits / 8)
    throw Error('Expected mono/stereo PCM16, PCM24 or IEEE float WAV')
  if (data.length % align) throw Error('Partial WAV sample frame')
  const frames = data.length / align
  const length = Math.round(frames * sampleRate / rate)
  const left = new Float32Array(length), right = channels === 2 ? new Float32Array(length) : undefined
  const read = (frame, channel) => {
    const offset = frame * align + channel * bits / 8
    if (pcm) return data.readIntLE(offset, bits / 8) / 2 ** (bits - 1)
    return (bits === 32 ? data.readFloatLE(offset) : data.readDoubleLE(offset))
  }
  for (let i = 0; i < length; i++) {
    const pos = i * rate / sampleRate
    const a = Math.min(frames - 1, Math.floor(pos)), b = Math.min(frames - 1, a + 1)
    const fraction = pos - a
    const l = read(a, 0)
    left[i] = l + (read(b, 0) - l) * fraction
    if (right) {
      const r = read(a, 1)
      right[i] = r + (read(b, 1) - r) * fraction
    }
  }
  return { left, right }
}

export function floatWavHeader(frames) {
  const size = frames * 8
  if (size > 0xffffffff - 48) throw Error('Render exceeds RIFF size limit')
  const header = Buffer.alloc(56)
  header.write('RIFF')
  header.writeUInt32LE(size + 48, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(3, 20)
  header.writeUInt16LE(2, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 8, 28)
  header.writeUInt16LE(8, 32)
  header.writeUInt16LE(32, 34)
  header.write('fact', 36)
  header.writeUInt32LE(4, 40)
  header.writeUInt32LE(frames, 44)
  header.write('data', 48)
  header.writeUInt32LE(size, 52)
  return header
}
