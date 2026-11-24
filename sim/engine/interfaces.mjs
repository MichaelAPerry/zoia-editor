import { button } from './control.mjs'
import { sampleRate } from './dsp.mjs'
import { dbGain } from './layout.mjs'

const idle = () => () => {}
const cvInput = ({ id, put, knob }) => () => put(id === 54 ? 'cv_output' : 'cv_out', knob('value', 0))

export const interfaces = {
  16: idle,
  20: idle,
  21({ options, put }) {
    const index = (options.midi_channel - 1) * 128 + options.controller
    const bipolar = options.output_range === '-1 to 1'
    return io => {
      const value = io.midiCC?.get(index)
      put('cc_out', value === undefined ? 0 : bipolar ? value / 127 * 2 - 1 : value / 127)
    }
  },
  35: idle,
  54: cvInput,
  55: idle,
  62: idle,
  82({ bpm, put, options }) {
    if (!bpm) return idle()
    const [numerator, denominator = 1] = options.beat_modifier.split('/').map(Number)
    const beat = 60 * sampleRate / bpm
    const quarter = options.divider === 'enabled' ? beat * denominator / numerator : beat
    const tick = beat / 24
    let frame = 0
    return () => {
      put('quarter_out', Number(frame % quarter < Math.min(48, quarter * 0.5)))
      put('clock_out', Number(frame % tick < Math.min(48, tick * 0.5)))
      put('reset_out', Number(frame < 48))
      put('run_out', 1)
      frame++
    }
  },
  84: idle,
  86: idle,
  87: idle,
  88: cvInput,
  89: cvInput,
  90: cvInput,
  91: cvInput,
  92: ({ unit }) => io => { io.headphoneGain *= dbGain(unit('level')) },
  93: ({ put }) => io => put('output', io.left),
  94: ({ put }) => io => put('output', io.right),
  95: ({ p }) => io => { io.outL += p('input') },
  96: ({ p }) => io => { io.outR += p('input') },
  97: button,
  98: button,
  99: idle,
  100: idle,
  101: idle,
  103: idle,
}
