import { pcmWav } from './logic.js'

function testSignal(context, kind) {
  const rate = context.sampleRate
  const duration = { pluck: 4, drums: 2, click: 2, noise: 4 }[kind]
  const buffer = context.createBuffer(1, rate * duration, rate)
  const samples = buffer.getChannelData(0)
  const notes = [48, 55, 60, 63, 58, 55, 53, 51]
  for (let i = 0; i < samples.length; i++) {
    const time = i / rate
    const noise = 2 * Math.random() - 1
    if (kind === 'pluck') {
      const t = time % .5
      const hz = 440 * 2 ** ((notes[Math.floor(time * 2)] - 69) / 12)
      const phase = 2 * Math.PI * hz * t
      samples[i] = .34 * Math.min(1, 800 * t) * Math.exp(-12 * t)
        * (Math.sin(phase) + .26 * Math.sin(2 * phase) + .12 * Math.sin(3 * phase))
    } else if (kind === 'drums') {
      const beat = time % .5
      const eighth = time % .25
      const kick = .55 * Math.sin(2 * Math.PI * (45 * beat + 4 * (1 - Math.exp(-28 * beat)))) * Math.exp(-22 * beat)
      const snare = Math.floor(time * 2) % 2 ? .22 * noise * Math.exp(-31 * beat) : 0
      samples[i] = kick + snare + .08 * (i % 2 ? noise : -noise) * Math.exp(-75 * eighth)
    } else if (kind === 'click') {
      samples[i] = .55 * Math.sin(2 * Math.PI * 1300 * time) * Math.exp(-340 * time)
    } else {
      const envelope = Math.max(0, Math.min(1, time * 150, (.6 - time) * 150))
      samples[i] = .26 * noise * envelope
    }
  }
  return buffer
}

export class Simulator {
  constructor({ meters, report, recording }) {
    this.meters = meters
    this.report = report
    this.recording = recording
    this.sourceVersion = 0
  }

  send(type, fields = {}) {
    this.node?.port.postMessage({ type, ...fields })
  }

  async start(getPatch, source, file, volume) {
    const context = new AudioContext({ sampleRate: 48000 })
    this.context = context
    try {
      await Promise.all([
        context.resume(),
        context.audioWorklet.addModule(new URL('../core/worklet.js', import.meta.url)),
        context.audioWorklet.addModule(new URL('./recorder.js', import.meta.url)),
      ])
      if (this.context !== context) return
      this.node = new AudioWorkletNode(context, 'zoia-simulator', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      })
      this.node.port.onmessage = ({ data }) => {
        if (data.type === 'meters') this.meters(data)
        if (data.type === 'error' || data.command === 'loadPatch') this.report(data)
      }
      this.node.onprocessorerror = () => this.report({ type: 'error', message: 'Simulator processor stopped' })
      this.gain = context.createGain()
      this.gain.gain.value = volume
      this.capture = new AudioWorkletNode(context, 'zoia-wav-capture', {
        numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit',
      })
      this.capture.port.onmessage = ({ data }) => this.recording(pcmWav(data, context.sampleRate))
      this.node.connect(this.gain)
      this.gain.connect(context.destination)
      this.gain.connect(this.capture)
      this.send('loadPatch', { patch: getPatch() })
      this.timer = setInterval(() => this.send('getMeters'), 100)
      await this.useSource(source, file)
    } catch (error) {
      if (this.context !== context) return
      this.stop()
      throw error
    }
  }

  async useSource(kind, file) {
    const context = this.context
    if (!this.node) return
    const version = ++this.sourceVersion
    let stream
    let input
    try {
      if (kind === 'live') {
        stream = await navigator.mediaDevices.getUserMedia({ audio: {
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        } })
        if (version !== this.sourceVersion) return
        const mono = context.createGain()
        // Web Audio's speaker downmix averages stereo. The worklet duplicates mono to L/R.
        mono.channelCount = 1
        mono.channelCountMode = 'explicit'
        const mic = context.createMediaStreamSource(stream)
        mic.connect(mono)
        input = mono
      } else {
        if (kind === 'file' && !file) throw new Error('Open an audio file first')
        const buffer = kind === 'file'
          ? await context.decodeAudioData(await file.arrayBuffer())
          : testSignal(context, kind)
        if (version !== this.sourceVersion) return
        input = context.createBufferSource()
        input.buffer = buffer
        input.loop = true
        input.start()
      }
      this.clearSource()
      input.connect(this.node)
      this.input = input
      this.stream = stream
    } catch (error) {
      if (version === this.sourceVersion) throw error
    } finally {
      if (stream !== this.stream) stream?.getTracks().forEach(track => track.stop())
    }
  }

  clearSource() {
    this.input?.stop?.()
    this.input?.disconnect()
    this.stream?.getTracks().forEach(track => track.stop())
    this.input = this.stream = null
  }

  setVolume(value) {
    if (this.gain) this.gain.gain.setTargetAtTime(value, this.context.currentTime, .015)
  }

  record() {
    this.capture.port.postMessage({ frames: this.context.sampleRate * 10 })
  }

  stop() {
    this.sourceVersion++
    clearInterval(this.timer)
    this.clearSource()
    if (this.node) this.node.port.onmessage = null
    if (this.capture) this.capture.port.onmessage = null
    this.context?.close()
    this.context = this.node = this.gain = this.capture = null
  }
}
