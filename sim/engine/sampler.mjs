import { blend, edge, sampleRate } from './dsp.mjs'
import { clamp } from './layout.mjs'

const capacity = 600 * sampleRate

export function sampler({ p, put, options, sample }) {
  const { record, playback } = options
  const startRecord = edge(), startPlay = edge()
  const initialLeft = sample?.left ?? []
  const initialRight = sample?.right ?? initialLeft
  if (initialLeft.length !== initialRight.length || initialLeft.length > capacity)
    throw Error('Sampler PCM channels must have equal lengths of up to ten minutes')
  let left = Float32Array.from(initialLeft), right = Float32Array.from(initialRight)
  let size = left.length, playing = false, start = 0, end = 0, position = 0

  return () => {
    // ASSUMPTION: Use engine-local memory with no SD file, and capture a new
    // sample while record stays high. New recording takes priority over play.
    const recordHigh = record !== 'disabled' && p('record') > 0.5
    const recordEdge = startRecord(Number(recordHigh))
    const playEdge = startPlay(p('sample_playback'))
    const reverse = p('direction') > 0.5
    if (record === 'new sample' && recordHigh) {
      if (recordEdge) size = 0
      playing = false
      if (size < capacity) {
        if (size === left.length) {
          const nextSize = Math.min(capacity, Math.max(4096, size * 2))
          const nextLeft = new Float32Array(nextSize), nextRight = new Float32Array(nextSize)
          nextLeft.set(left)
          nextRight.set(right)
          left = nextLeft
          right = nextRight
        }
        left[size] = clamp(p('audio_in_L'), -1, 1)
        right[size++] = clamp(p('audio_in_R'), -1, 1)
      }
    } else if (playEdge && size) {
      start = Math.floor(size * clamp(p('start')))
      end = Math.min(size, start + Math.round(size * clamp(p('length'))))
      position = reverse ? end - 1 : start
      playing = end > start
    }
    if (playback !== 'trigger' && p('sample_playback') <= 0.5) playing = false

    let l = 0, r = 0, cv = 0, ended = false
    if (playing) {
      const index = Math.floor(clamp(position, start, end - 1))
      const next = Math.min(end - 1, index + 1)
      const fraction = clamp(position - index)
      // ASSUMPTION: Overdub/punch-in write to the current playback frame
      // during an active record gate and saturate the recorded signal.
      if (recordHigh && record !== 'new sample') {
        const keep = record === 'overdub'
        left[index] = clamp((keep ? left[index] : 0) + p('audio_in_L'), -1, 1)
        right[index] = clamp((keep ? right[index] : 0) + p('audio_in_R'), -1, 1)
      }
      l = blend(left[index], left[next], fraction)
      r = blend(right[index], right[next], fraction)
      cv = clamp((position - start) / Math.max(1, end - start - 1))
      // The guide gives a ±60-semitone range centered at unity speed.
      const offset = clamp(p('speed_pitch')) - 0.5
      const speed = Math.abs(offset) <= 1 / 65535 ? 1 : 2 ** (10 * offset)
      position += reverse ? -speed : speed
      ended = reverse ? position <= start - 1 : position >= end
      if (ended) {
        if (playback === 'loop') {
          const length = end - start
          position = start + ((position - start) % length + length) % length
          if (reverse && position > end - 1) position -= length
        } else playing = false
      }
    }
    put('audio_out_L', l)
    put('audio_out_R', r)
    put('position_cv_out', cv)
    // ASSUMPTION: End pulses last one simulator sample.
    put('loop_end_cv_out', Number(ended))
  }
}
