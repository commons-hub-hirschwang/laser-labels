// The xTool S1 over USB with Web Serial (Chrome/Edge). Reverse-engineered from xTool Studio
// 1.9.11 talking to the machine:
// - Commands are text lines. The S1 answers M-codes with a line starting with the same code
//   (G-code moves get no answer) and also pushes lines on its own, e.g. "M222 S13".
// - Files go up in binary frames: F3 · header sum · length (u16 LE) · payload · payload sum · F4,
//   both sums being byte sums & 0xFF. Payload: 01 01 5E · command · data length (u16 LE) · data.
//   Command 01 announces the file (00 · size u32 LE · XOR checksum · name), command 02 carries
//   up to 16 KB (offset u32 LE · bytes). The S1 acknowledges each frame with command F0, whose
//   frame byte 10 is 1 on error.

import type { Point } from './pathGeometry'

const usbFilter = { usbVendorId: 0x28e9, usbProductId: 0x018a }
const chunkSize = 16 * 1024
const timeout = 5000
const uploadTimeout = 15000

export const serialSupported = 'serial' in navigator

const byteSum = (bytes: ArrayLike<number>) => {
  let sum = 0
  for (let i = 0; i < bytes.length; i++) sum += bytes[i]!
  return sum & 0xff
}
const u16 = (value: number) => [value & 0xff, (value >> 8) & 0xff]
const u32 = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]

export function frame(command: number, data: ArrayLike<number>) {
  const payload = [0x01, 0x01, 0x5e, command, ...u16(data.length), ...Array.from(data)]
  const length = u16(payload.length)
  return Uint8Array.from([0xf3, byteSum([0xf3, ...length]), ...length, ...payload, byteSum(payload), 0xf4])
}

/** Studio's file checksum: the file XORed onto itself in 4-byte steps */
export function xorChecksum(bytes: Uint8Array) {
  const sum = [0, 0, 0, 0]
  bytes.forEach((byte, index) => (sum[index % 4]! ^= byte))
  return sum
}

export function fileFrames(name: string, content: Uint8Array) {
  const head = [0x00, ...u32(content.length), ...xorChecksum(content), ...new TextEncoder().encode(name)]
  const frames = [frame(0x01, head)]
  for (let offset = 0; offset < content.length; offset += chunkSize) {
    frames.push(frame(0x02, [...u32(offset), ...content.subarray(offset, offset + chunkSize)]))
  }
  return frames
}

interface Waiter {
  match: (reply: string | Uint8Array) => boolean
  resolve: (reply: string | Uint8Array) => void
}

export class S1 {
  /** M222 state, pushed by the S1 and answered on request */
  onState: (state: number) => void = () => {}
  onPosition: (position: Point) => void = () => {}
  onClose: () => void = () => {}

  private writer: WritableStreamDefaultWriter<Uint8Array>
  private waiters: Waiter[] = []
  /** commands run one at a time, so answers can be matched */
  private queue: Promise<unknown> = Promise.resolve()
  private polling = 0
  private port: SerialPort
  private reader?: ReadableStreamDefaultReader<Uint8Array>
  private closed = false

  private constructor(port: SerialPort) {
    this.port = port
    this.writer = port.writable!.getWriter()
    void this.read()
    this.polling = window.setInterval(() => void this.position().catch(() => {}), 1000)
  }

  /** asks the browser for the S1's port */
  static async connect() {
    const port = await navigator.serial.requestPort({ filters: [usbFilter] })
    // CDC serial ignores the baud rate, Web Serial still needs one
    await port.open({ baudRate: 115200 })
    const s1 = new S1(port)
    const name = await s1.command('M100')
    if (!name.includes('xTool S1')) {
      await s1.close()
      throw new Error(`Not an xTool S1: ${name}`)
    }
    // Studio sets this right after connecting
    await s1.command('M97 S0\nM96 S1')
    return s1
  }

  async close() {
    if (this.closed) return
    this.closed = true
    window.clearInterval(this.polling)
    try {
      await this.reader?.cancel()
      this.writer.releaseLock()
      await this.port.close()
    } catch {
      // already gone
    }
    this.onClose()
  }

  private async read() {
    const decoder = new TextDecoder()
    let buffer = new Uint8Array(0)
    try {
      while (this.port.readable && !this.closed) {
        const reader = (this.reader = this.port.readable.getReader())
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            const joined = new Uint8Array(buffer.length + value.length)
            joined.set(buffer)
            joined.set(value, buffer.length)
            buffer = joined
            let consumed = 0
            for (;;) {
              const rest = buffer.subarray(consumed)
              if (rest[0] === 0xf3 && rest.length < 4) break // frame length not here yet
              if (rest[0] === 0xf3) {
                const end = 5 + (rest[2]! | (rest[3]! << 8))
                if (rest.length <= end) break // frame not complete yet
                if (rest[end] === 0xf4) {
                  this.dispatch(rest.slice(0, end + 1))
                  consumed += end + 1
                  continue
                }
              }
              const newline = rest.indexOf(0x0a)
              if (newline < 0) break
              const line = decoder.decode(rest.subarray(0, newline)).trim()
              consumed += newline + 1
              if (line) this.dispatch(line)
            }
            buffer = buffer.slice(consumed)
          }
        } finally {
          reader.releaseLock()
        }
      }
    } catch {
      // unplugged
    }
    void this.close()
  }

  private dispatch(reply: string | Uint8Array) {
    if (typeof reply === 'string') {
      const state = reply.match(/^M222 S(\d+)/)
      if (state) this.onState(Number(state[1]))
    }
    const index = this.waiters.findIndex((waiter) => waiter.match(reply))
    if (index >= 0) this.waiters.splice(index, 1)[0]!.resolve(reply)
  }

  private waitFor<T extends string | Uint8Array>(match: (reply: string | Uint8Array) => boolean, ms: number, what: string) {
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = { match, resolve: (reply) => { clearTimeout(timer); resolve(reply as T) } }
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        reject(new Error(`The S1 did not answer ${what}`))
      }, ms)
      this.waiters.push(waiter)
    })
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task)
    this.queue = result.catch(() => {})
    return result
  }

  private write(bytes: Uint8Array) {
    return this.writer.write(bytes)
  }

  /** sends a command (several lines allowed) and resolves with the answer to its first M-code */
  command(command: string): Promise<string> {
    const code = command.match(/^M\d+/)![0]
    return this.exclusive(async () => {
      const answer = this.waitFor<string>((reply) => typeof reply === 'string' && new RegExp(`^${code}(?!\\d)`).test(reply), timeout, code)
      await this.write(new TextEncoder().encode(`${command}\n\n`))
      return answer
    })
  }

  /** commands without an answer, like G0 moves */
  send(command: string) {
    return this.exclusive(() => this.write(new TextEncoder().encode(`${command}\n\n`)))
  }

  async state() {
    return Number((await this.command('M222')).match(/S(\d+)/)?.[1])
  }

  async position(): Promise<Point> {
    const answer = await this.command('M303')
    const position = { x: Number(answer.match(/X(-?[\d.]+)/)?.[1]), y: Number(answer.match(/Y(-?[\d.]+)/)?.[1]) }
    this.onPosition(position)
    return position
  }

  /**
   * Red cross position relative to the laser. The S1 stores it for the lowest and highest head
   * position (M1109 A–E); like Studio, this takes the middle.
   */
  async crossOffset(): Promise<Point> {
    const answer = await this.command('M1109')
    const value = (key: string) => Number(answer.match(new RegExp(`${key}(-?[\\d.]+)`))?.[1] ?? 0)
    const [bottomX, bottomY, topX, topY, maxZ] = ['A', 'B', 'C', 'D', 'E'].map(value) as [number, number, number, number, number]
    const z = (maxZ || 55) / 2
    const ratio = z / (maxZ || 55)
    return { x: bottomX + (topX - bottomX) * ratio, y: bottomY + (topY - bottomY) * ratio }
  }

  moveTo({ x, y }: Point) {
    return this.send(`G0 X${x.toFixed(2)} Y${y.toFixed(2)} F9600`)
  }

  /** uploads the job as tmp.gcode; the S1 then waits for its button (state 13) */
  async sendJob(gcode: string, onProgress: (fraction: number) => void) {
    await this.command('M362')
    await this.command('M321')
    await this.command('M25')
    await this.command('M2240')
    await this.command(`M810 "${crypto.randomUUID()}"`)
    const frames = fileFrames('tmp.gcode', new TextEncoder().encode(gcode))
    try {
      await this.exclusive(async () => {
        for (const [index, bytes] of frames.entries()) {
          const ack = this.waitFor<Uint8Array>((reply) => typeof reply !== 'string' && reply[7] === 0xf0, uploadTimeout, 'the upload')
          await this.write(bytes)
          if ((await ack)[10] === 1) throw new Error('The S1 rejected the upload')
          onProgress((index + 1) / frames.length)
        }
      })
    } catch (error) {
      // tells the S1 the file is incomplete, as Studio does
      await this.command('M323 S0').catch(() => {})
      throw error
    }
    await this.command('M323 S1')
  }
}
