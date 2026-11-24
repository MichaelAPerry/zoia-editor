import { blend } from './dsp.mjs'
import { clamp } from './layout.mjs'

export function loopBuffer(capacity) {
  // Allocate only when recording begins. Saved patches carry controls but no audio.
  let data, length = 0, position = 0
  return {
    get length() { return length },
    clear() { length = position = 0 },
    rewind(reverse = false, start = 0, end = length) {
      position = reverse ? end - 1 : start
    },
    record(value) {
      data ??= new Float32Array(capacity)
      if (length < capacity) data[length++] = value
      return length < capacity
    },
    read(start, end, rate, repeat, overdub) {
      if (position < start || position >= end) {
        if (!repeat) return 0
        const span = end - start
        position = start + ((position - start) % span + span) % span
      }
      const index = Math.floor(position)
      const next = index + 1 < end ? index + 1 : repeat ? start : index
      const value = blend(data[index], data[next], position - index)
      if (overdub !== undefined) data[index] = clamp(value + overdub, -1, 1)
      position += rate
      return value
    },
  }
}
