// SVG path data as polylines, and the fill of closed paths along horizontal lines.
// Handles the absolute commands label.ts and pattern.ts write: M L H V Q C A Z.
// All geometry is in millimetres.

export interface Point { x: number; y: number }
export type Polyline = Point[]

/** maximum distance between a curve and the lines that replace it */
const tolerance = 0.005

const tokenPattern = /[MLHVQCAZ]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi

export function flatten(d: string): Polyline[] {
  const tokens = d.match(tokenPattern) ?? []
  const lines: Polyline[] = []
  let line: Polyline = []
  let current: Point = { x: 0, y: 0 }
  let start = current
  let command = ''
  let index = 0
  const number = () => Number(tokens[index++])
  const lineTo = (point: Point) => {
    line.push(point)
    current = point
  }

  while (index < tokens.length) {
    // a command letter, or more numbers for the previous command
    if (/[a-z]/i.test(tokens[index]!)) {
      command = tokens[index++]!
      if (command !== command.toUpperCase()) throw new Error(`relative path command ${command} not supported`)
    }
    switch (command) {
      case 'M':
        if (line.length > 1) lines.push(line)
        current = start = { x: number(), y: number() }
        line = [current]
        command = 'L' // further coordinate pairs are lines
        break
      case 'L': lineTo({ x: number(), y: number() }); break
      case 'H': lineTo({ x: number(), y: current.y }); break
      case 'V': lineTo({ x: current.x, y: number() }); break
      case 'Q': {
        const control = { x: number(), y: number() }
        const end = { x: number(), y: number() }
        quadratic(current, control, end).forEach(lineTo)
        break
      }
      case 'C': {
        const c1 = { x: number(), y: number() }
        const c2 = { x: number(), y: number() }
        const end = { x: number(), y: number() }
        cubic(current, c1, c2, end).forEach(lineTo)
        break
      }
      case 'A': {
        const [rx, ry, rotation, large, sweep, x, y] = [number(), number(), number(), number(), number(), number(), number()]
        arc(current, rx, ry, rotation, large === 1, sweep === 1, { x, y }).forEach(lineTo)
        break
      }
      case 'Z':
        if (current.x !== start.x || current.y !== start.y) lineTo(start)
        if (line.length > 1) lines.push(line)
        line = [start]
        current = start
        command = ''
        break
      default:
        throw new Error(`unexpected path data at "${tokens[index]}"`)
    }
  }
  if (line.length > 1) lines.push(line)
  return lines
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

function quadratic(p0: Point, p1: Point, p2: Point): Point[] {
  const bend = Math.hypot(p0.x - 2 * p1.x + p2.x, p0.y - 2 * p1.y + p2.y)
  const steps = Math.max(1, Math.ceil(Math.sqrt(bend / (4 * tolerance))))
  return Array.from({ length: steps }, (_, i) => {
    const t = (i + 1) / steps
    const u = 1 - t
    return { x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y }
  })
}

function cubic(p0: Point, p1: Point, p2: Point, p3: Point): Point[] {
  const bend = Math.max(
    Math.hypot(p0.x - 2 * p1.x + p2.x, p0.y - 2 * p1.y + p2.y),
    Math.hypot(p1.x - 2 * p2.x + p3.x, p1.y - 2 * p2.y + p3.y),
  )
  const steps = Math.max(1, Math.ceil(Math.sqrt((3 * bend) / (4 * tolerance))))
  return Array.from({ length: steps }, (_, i) => {
    const t = (i + 1) / steps
    const u = 1 - t
    const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
    return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y }
  })
}

/** endpoint arc as in the SVG spec, converted to centre form (SVG 1.1, appendix F.6.5) */
function arc(from: Point, rx: number, ry: number, rotation: number, large: boolean, sweep: boolean, to: Point): Point[] {
  if (rx === 0 || ry === 0 || distance(from, to) === 0) return distance(from, to) === 0 ? [] : [to]
  const phi = (rotation * Math.PI) / 180
  const [cos, sin] = [Math.cos(phi), Math.sin(phi)]
  const dx = (from.x - to.x) / 2
  const dy = (from.y - to.y) / 2
  const x1 = cos * dx + sin * dy
  const y1 = -sin * dx + cos * dy
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  // radii too small for the endpoints are scaled up
  const scale = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
  if (scale > 1) {
    rx *= Math.sqrt(scale)
    ry *= Math.sqrt(scale)
  }
  const numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
  const factor = (large === sweep ? -1 : 1) *
    Math.sqrt(Math.max(0, numerator / (rx * rx * y1 * y1 + ry * ry * x1 * x1)))
  const cx1 = (factor * rx * y1) / ry
  const cy1 = (-factor * ry * x1) / rx
  const cx = cos * cx1 - sin * cy1 + (from.x + to.x) / 2
  const cy = sin * cx1 + cos * cy1 + (from.y + to.y) / 2
  const angle = (ux: number, uy: number) => Math.atan2(uy, ux)
  const start = angle((x1 - cx1) / rx, (y1 - cy1) / ry)
  let delta = angle((-x1 - cx1) / rx, (-y1 - cy1) / ry) - start
  if (sweep && delta < 0) delta += 2 * Math.PI
  if (!sweep && delta > 0) delta -= 2 * Math.PI

  const r = Math.max(rx, ry)
  const maxStep = r > tolerance ? 2 * Math.acos(1 - tolerance / r) : Math.PI / 2
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / maxStep))
  return Array.from({ length: steps }, (_, i) => {
    if (i === steps - 1) return to
    const t = start + (delta * (i + 1)) / steps
    const [ex, ey] = [rx * Math.cos(t), ry * Math.sin(t)]
    return { x: cos * ex - sin * ey + cx, y: sin * ex + cos * ey + cy }
  })
}

export type FillRule = 'nonzero' | 'evenodd'

/** x ranges along the horizontal line at y that lie inside the (closed) polylines */
export function fillSpans(lines: Polyline[], y: number, rule: FillRule): [number, number][] {
  const crossings: { x: number; winding: number }[] = []
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const a = line[i]!
      const b = line[(i + 1) % line.length]! // implicitly closed, as for SVG fills
      if ((a.y <= y) === (b.y <= y)) continue
      crossings.push({ x: a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x), winding: b.y > a.y ? 1 : -1 })
    }
  }
  crossings.sort((a, b) => a.x - b.x)
  const spans: [number, number][] = []
  let winding = 0
  let spanStart = 0
  for (const crossing of crossings) {
    const inside = rule === 'nonzero' ? winding !== 0 : winding % 2 !== 0
    winding += crossing.winding
    const nowInside = rule === 'nonzero' ? winding !== 0 : winding % 2 !== 0
    if (!inside && nowInside) spanStart = crossing.x
    if (inside && !nowInside && crossing.x > spanStart) spans.push([spanStart, crossing.x])
  }
  return spans
}

/** sorted union of x ranges */
export function mergeSpans(spans: [number, number][]): [number, number][] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const span of sorted) {
    const last = merged[merged.length - 1]
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
    else merged.push([span[0], span[1]])
  }
  return merged
}

export function bounds(lines: Polyline[]) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const line of lines) {
    for (const { x, y } of line) {
      x1 = Math.min(x1, x)
      y1 = Math.min(y1, y)
      x2 = Math.max(x2, x)
      y2 = Math.max(y2, y)
    }
  }
  return x1 === Infinity ? undefined : { x1, y1, x2, y2 }
}
