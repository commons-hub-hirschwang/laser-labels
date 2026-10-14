// G-code for the xTool S1, written the way xTool Studio 1.9.11 writes it: header, bitmap
// engraving (filled black layers), vector engraving (pattern), vector cut, footer.
// Coordinates are machine coordinates in mm: label coordinates plus the label's position.

import { acceleration, focusZ, type LaserSettings } from './machine'
import { bounds, fillSpans, flatten, mergeSpans, type Point, type Polyline } from './pathGeometry'

export interface JobInput {
  textPath: string
  framePath: string
  patternPath: string
  cutPath: string
  /** label's top-left corner on the bed */
  position: Point
  settings: LaserSettings
  /** where the head is now; the job starts and ends there */
  head: Point
  date?: Date
}

/** the black layers' 0.1 mm outline stroke, which Studio burns too */
const strokeGrow = 0.05
/** Studio shifts right-to-left rows by this much (at 200 mm/s) */
const reverseRowShift = -0.047
/** air assist levels Studio used for engraving and cutting */
const engraveAir = 1
const cutAir = 4

const round = (value: number) => Math.round(value * 1000) / 1000
const num = (value: number) => String(round(value))
const fixed = (value: number) => round(value).toFixed(3)
const feed = (speed: number) => Math.round(speed * 60)
const sValue = (power: number) => Math.round(power * 10)

function header(head: Point, date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${date.getFullYear()}_${pad(date.getMonth() + 1)}_${pad(date.getDate())}_` +
    `${pad(date.getHours())}_${pad(date.getMinutes())}_${pad(date.getSeconds())}`
  return [
    `# date=${stamp}`,
    '# version=1.9.11',
    '# algorithmVersion=',
    '# gc={"size":{"w":498,"h":330}}',
    '# gc={"offset":{"x":0,"y":0}}',
    '# gc={"start":{"x":0,"y":0.0000}}',
    '# gc={"keys":["x","y"],"rm":1,"is3DMode":false}',
    '# timeConfig={"vectorAccel":500,"bitmapAccel":700,"thresholdAngle":1}',
    'G90',
    'G0 F3000',
    '# D2 HEAD',
    'M110 X1 Y1 Z1',
    'M109 S1',
    'M223 X498 Y330',
    'M7S1',
    'M96 S0',
    'G90',
    'G0Z0',
    'G92 U0',
    `M32 X${acceleration}`,
    `G0X${num(head.x)}Y${num(head.y)}`,
    'G0 F9600',
    'G198 P84 "M9033 V100"',
    'G198 P85 "M9401 D2 V500"',
    'M9064 B3',
    'G198 P70 "M9064 B3"',
    'G198 P78 "M9064 B3"',
    'M9039 C2',
    'G198 P69 "M9039 C2"',
    'G198 P76 "M9039 V50"',
    'G198 P76 "M9043 H11 I11 J11 K11 L11 M11"',
    'G1 F1000',
    '',
  ]
}

function footer(head: Point) {
  return [
    'G90',
    `G0X${num(head.x)}Y${num(head.y)}`,
    'G0 U0',
    '# END',
    'G0Z0',
    'G198 P84 "M9033 V0"',
    'G198 P85 "M9401 D2 V0"',
    'M9064 B0',
    'G198 P78 "M9064 B0"',
    'M9039 C0',
    'G198 P69 "M9039 C0"',
    'G198 P76 "M9039 V0"',
    '# END',
    'M6',
    '# D2 TAIL',
    '',
    '',
  ]
}

/**
 * Filled shapes as back-and-forth rows. Each row runs from its first to its last burn,
 * plus a laser-off run-up at both ends so the head burns at full speed only.
 */
function bitmap(text: Polyline[], frame: Polyline[], offset: Point, power: number, speed: number, lineSpacing: number) {
  const box = bounds([...text, ...frame])
  if (!box) return []
  const s = sValue(power)
  const runUp = (speed * speed) / (2 * acceleration)
  const lines = [
    '# D2 BITMAP START',
    'M4',
    `M15 S${engraveAir}`,
    '',
    '',
    `# blockConfig={"powerFactor":${power / 100},"density":${1 / lineSpacing},"power":[0,${s}],"bitmapMode":"grayscale","isVector":false}`,
    '',
    '',
    `G1F${feed(speed)}S0`,
  ]
  let started = false
  let forward = true
  for (let y = box.y1 - strokeGrow + lineSpacing / 2; y < box.y2 + strokeGrow; y += lineSpacing) {
    // rows within the stroke above or below a shape use the shape's nearest row
    const inner = Math.min(Math.max(y, box.y1 + 1e-6), box.y2 - 1e-6)
    const spans = mergeSpans([...fillSpans(text, inner, 'nonzero'), ...fillSpans(frame, inner, 'evenodd')]
      .map(([a, b]) => [a - strokeGrow, b + strokeGrow]))
    if (spans.length === 0) continue
    const shift = offset.x + (forward ? 0 : reverseRowShift)
    const row = spans.map(([a, b]) => [a + shift, b + shift] as const)
    if (!forward) row.reverse()
    const first = forward ? row[0]![0] : row[0]![1]
    const runUpStart = first + (forward ? -runUp : runUp)
    const machineY = fixed(y + offset.y)
    if (!started) {
      lines.push(`G0X${fixed(runUpStart)}Y${machineY}`, `G0Z${focusZ}`)
      started = true
    } else {
      lines.push(`G1Y${machineY}`, `G1X${fixed(runUpStart)}`)
    }
    row.forEach(([a, b], index) => {
      const [from, to] = forward ? [a, b] : [b, a]
      lines.push(index === 0 ? `G1X${fixed(from)}` : `G1X${fixed(from)}S0`, `G1X${fixed(to)}S${s}`)
    })
    const last = forward ? row[row.length - 1]![1] : row[row.length - 1]![0]
    lines.push(`G1X${fixed(last + (forward ? runUp : -runUp))}S0`)
    forward = !forward
  }
  lines.push('')
  return started ? lines : []
}

/** nearest next line first; open lines may run backwards, closed ones keep their start */
function order(lines: Polyline[], from: Point) {
  const left = lines.map((line) => ({ line, closed: distance(line[0]!, line[line.length - 1]!) < 1e-6 }))
  const ordered: Polyline[] = []
  let position = from
  while (left.length > 0) {
    let best = 0
    let bestDistance = Infinity
    let reverse = false
    left.forEach(({ line, closed }, index) => {
      const toStart = distance(position, line[0]!)
      if (toStart < bestDistance) [best, bestDistance, reverse] = [index, toStart, false]
      const toEnd = closed ? Infinity : distance(position, line[line.length - 1]!)
      if (toEnd < bestDistance) [best, bestDistance, reverse] = [index, toEnd, true]
    })
    const { line } = left.splice(best, 1)[0]!
    const next = reverse ? [...line].reverse() : line
    ordered.push(next)
    position = next[next.length - 1]!
  }
  return ordered
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

function vector(lines: Polyline[], offset: Point, power: number, speed: number, mode: 'M3' | 'M4', air: number) {
  if (lines.length === 0) return []
  const s = sValue(power)
  const point = (p: Point) => `X${fixed(p.x + offset.x)}Y${fixed(p.y + offset.y)}`
  const output = [
    '# VECTOR START',
    'G90',
    mode,
    `M15 S${air}`,
    `# blockConfig={"powerFactor": ${power / 100}, "isVector": true} `,
  ]
  lines.forEach((line, index) => {
    output.push(`G0${point(line[0]!)}`)
    if (index === 0) output.push(`G0Z${focusZ}`, `G0${point(line[0]!)}`)
    let previous = line[0]!
    let first = true
    for (const p of line.slice(1)) {
      if (distance(p, previous) < 0.001) continue
      output.push(`G1${point(p)}${first ? `S${s}F${feed(speed)}` : ''}`)
      previous = p
      first = false
    }
  })
  return output
}

export function generateJob(input: JobInput) {
  const { position, settings, head } = input
  const text = flatten(input.textPath)
  const frame = flatten(input.framePath)
  const pattern = flatten(input.patternPath)
  // holes first, so the label doesn't move before they are cut; the outline encloses everything
  const cut = flatten(input.cutPath)
  const area = (line: Polyline) => {
    const box = bounds([line])!
    return (box.x2 - box.x1) * (box.y2 - box.y1)
  }
  const outline = cut.reduce((largest, line) => (area(line) > area(largest) ? line : largest), cut[0]!)
  const holes = cut.filter((line) => line !== outline)
  const labelHead = { x: head.x - position.x, y: head.y - position.y }
  const patternLines = order(pattern, { x: 0, y: 0 })
  const holeLines = order(holes, patternLines.at(-1)?.at(-1) ?? labelHead)

  return [
    ...header(head, input.date ?? new Date()),
    ...bitmap(text, frame, position, settings.engrave.power, settings.engrave.speed, settings.lineSpacing),
    ...vector(patternLines, position, settings.pattern.power, settings.pattern.speed, 'M4', engraveAir),
    ...vector(cut.length ? [...holeLines, outline] : [], position, settings.cut.power, settings.cut.speed, 'M3', cutAir),
    ...footer(head),
  ].join('\n')
}
export interface FrameJobInput {
  position: Point
  width: number
  height: number
  /** current head position; the job starts and ends here */
  head: Point
  date?: Date
}

/** Traces the label bounds at its machine coordinates with the laser off. */
export function generateFrameJob(input: FrameJobInput) {
  const { position, width, height, head } = input
  const corners = [
    { x: position.x, y: position.y },
    { x: position.x + width, y: position.y },
    { x: position.x + width, y: position.y + height },
    { x: position.x, y: position.y + height },
  ]
  const point = ({ x, y }: Point) => `X${fixed(x)}Y${fixed(y)}`
  const frameHeader = header(head, input.date ?? new Date()).map((line) => ({
    'M109 S1': 'M109 S0',
    'M7S1': 'M7S0',
    'M96 S0': 'M96 S1',
  }[line] ?? line))
  return [
    ...frameHeader,
    '# VECTOR START',
    'G90',
    'M4',
    '# blockConfig={"powerFactor": 0, "isVector": true}',
    `G0${point(corners[0]!)}`,
    'G0Z30.000',
    `G0${point(corners[0]!)}`,
    `G1${point(corners[1]!)}S0F9600`,
    `G1${point(corners[2]!)}`,
    `G1${point(corners[3]!)}`,
    `G1${point(corners[0]!)}`,
    ...footer(head),
  ].join('\n')
}
