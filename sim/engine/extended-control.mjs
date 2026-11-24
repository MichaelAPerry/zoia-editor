import { blend, clean, coefficient, edge, sampleRate } from './dsp.mjs'
import { clamp } from './layout.mjs'
import { loopBuffer } from './loop.mjs'

const pulseFrames = 48
const scales = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  [0, 2, 4, 5, 7, 9, 11], [0, 2, 3, 5, 7, 8, 10],
  [0, 2, 4, 7, 9], [0, 3, 5, 7, 10], [0, 3, 5, 6, 7, 10],
  [0, 2, 3, 5, 7, 9, 10], [0, 2, 4, 5, 7, 9, 10],
  [0, 2, 3, 5, 7, 8, 11], [0, 2, 3, 5, 7, 9, 11],
]

export const extendedControls = {
  18({ p, unit, put }) {
    let last = 0, rising = false, frame = 0, lastRise = -1, next = 0
    let period = sampleRate / 2, held = 0
    return () => {
      const x = p('cv_input')
      if (x > last && !rising) {
        if (lastRise >= 0) period = frame - lastRise
        lastRise = frame
        next = frame
        rising = true
      } else if (x < last) rising = false
      if (frame >= next) {
        held = x
        next += Math.max(1, period / Math.round(unit('quant_steps')))
      }
      last = x
      frame++
      put('cv_output', held)
    }
  },
  28({ p, put, has, u8, options }) {
    return () => {
      const key = has('key') ? Math.round(clamp(p('key')) * 12) % 12 : u8(3) % 12
      const count = options.scales === 'extended' ? scales.length : 6
      const scale = scales[has('scale') ? Math.round(clamp(p('scale')) * (count - 1)) : u8(0) % count]
      const note = clamp(p('cv_input')) * 120
      let nearest = 0, distance = Infinity
      const octave = Math.floor((note - key) / 12)
      for (let base = octave - 1; base <= octave + 1; base++) {
        for (const interval of scale) {
          const candidate = base * 12 + interval + key
          const difference = Math.abs(note - candidate)
          if (candidate >= 0 && candidate <= 120 && difference < distance) {
            nearest = candidate
            distance = difference
          }
        }
      }
      put('cv_output', nearest / 120)
    }
  },
  37({ p, put, u32, savedLength }) {
    let hits = []
    for (let offset = 0; offset < savedLength; offset += 4) {
      const hit = u32(offset)
      if (!hit) break
      hits.push(hit)
    }
    const record = edge(), play = edge(), trigger = edge()
    let recording = false, playing = false, frame = 0, start = 0, index = 0, pulse = 0, done = 0
    return () => {
      const hit = trigger(p('rhythm_in'))
      if (record(p('rec_start_stop'))) {
        recording = !recording
        if (recording) {
          hits = []
          playing = false
          start = frame
        }
      }
      if (recording && hit && hits.length < 4096) hits.push(frame - start)
      if (play(p('play')) && !recording && hits.length) {
        playing = true
        start = frame
        index = 0
      }
      if (playing && frame - start >= hits[index]) {
        pulse = pulseFrames
        if (++index === hits.length) {
          playing = false
          done = pulseFrames
        }
      }
      frame++
      put('rhythm_out', Number(pulse > 0))
      put('done_out', Number(done > 0))
      pulse = Math.max(0, pulse - 1)
      done = Math.max(0, done - 1)
    }
  },
  47({ p, put, unit, has, options }) {
    const buffer = loopBuffer(options.max_rec_time * sampleRate)
    const record = edge(), play = edge(), restart = edge()
    let recording = false, playing = true
    return () => {
      if (record(p('record'))) {
        recording = !recording
        if (recording) buffer.clear()
      }
      if (play(p('play'))) playing = !playing
      const start = has('start_position') ? clamp(Math.round(unit('start_position') * sampleRate), 0, Math.max(0, buffer.length - 1)) : 0
      const end = has('stop_position') ? clamp(Math.round(unit('stop_position') * sampleRate), start + 1, buffer.length) : buffer.length
      if (restart(p('restart_loop'))) buffer.rewind(false, start)
      const input = p('cv_input')
      let y = 0
      if (recording) {
        recording = buffer.record(input)
        y = input
      } else if (playing && buffer.length) {
        y = buffer.read(start, end, unit('playback_speed') / 100, true)
      }
      put('cv_output', y)
    }
  },
  48({ p, put, unit, options }) {
    let y = 0
    return () => {
      const x = p('cv_input')
      const key = options.control === 'linked' ? 'time_constant' : x > y ? 'rise_constant' : 'fall_constant'
      y = clean(blend(y, x, coefficient(unit(key) / 1000)))
      put('cv_output', y)
    }
  },
  51: ({ p, put }) => () => put('cv_output', Math.abs(p('cv_input'))),
  77({ p, put, u8 }) {
    const rising = edge()
    let high = Boolean(u8(0))
    return () => {
      if (rising(p('cv_input'))) high = !high
      put('cv_output', Number(high))
    }
  },
  85({ p, put, unit, u32, options }) {
    const tapEdge = edge()
    let period = u32(4, sampleRate / 2), elapsed = 0, tapped = false
    return () => {
      elapsed++
      if (tapEdge(p('tap_input'))) {
        if (tapped) period = elapsed
        tapped = true
        elapsed = 0
      }
      const min = options.range === 'on' ? unit('min_time') : 0.02
      const max = Math.max(min + 0.01, options.range === 'on' ? unit('max_time') : 60000)
      const ms = clamp(period / 48, min, max)
      const x = options.output === 'exponential' ? Math.log(ms / min) / Math.log(max / min) : (ms - min) / (max - min)
      put('output', x)
    }
  },
}
