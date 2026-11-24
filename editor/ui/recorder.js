class WavCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.port.onmessage = ({ data }) => {
      this.channels = [new Float32Array(data.frames), new Float32Array(data.frames)]
      this.offset = 0
    }
  }

  process([input]) {
    if (!this.channels || !input.length) return true
    const count = Math.min(input[0].length, this.channels[0].length - this.offset)
    this.channels.forEach((channel, index) => channel.set(
      (input[index] ?? input[0]).subarray(0, count), this.offset))
    this.offset += count
    if (this.offset === this.channels[0].length) {
      this.port.postMessage(this.channels, this.channels.map(channel => channel.buffer))
      this.channels = null
    }
    return true
  }
}

registerProcessor('zoia-wav-capture', WavCapture)
