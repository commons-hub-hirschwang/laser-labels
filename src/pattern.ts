// Background patterns traced by particles. All geometry is in millimetres.
//
// Particles stay in a free-space mask (inside the frame, away from text and holes) and stop
// when they come too close to another line. Two styles use simplex noise differently:
//
// - contours: the noise is a height map and particles move along its contour lines
//   (perpendicular to the slope), so their trails ring around hills and run through valleys
//   like a topographic map. New lines start one spacing beside finished ones, which keeps
//   the spacing even.
// - flow: the noise is the direction particles move in. Particles start at random points
//   and run downstream until they meet another line, where they join it, so streams unite
//   into larger flows.
// - network: not particles but a network. Dots on a jittered grid are linked to their natural
//   neighbours, and some dots are hubs whose spokes reach further, like stars. Dots with
//   more links are drawn larger.
//
// Growth runs step by step, so the preview can animate it.

import { createNoise2D } from 'simplex-noise'

export type PatternStyle = 'contours' | 'flow' | 'network'

export interface PatternInput {
  style: PatternStyle
  width: number
  height: number
  /** area the pattern may fill */
  region: { x1: number; y1: number; x2: number; y2: number }
  /** SVG path data of the text */
  textPath: string
  holes: { x: number; y: number; r: number }[]
  /** distance kept to text; the pattern runs right up to the region edge */
  clearance: number
  seed: number
}

const step = 0.25 // particle step length
const spacing = 1 // distance between neighbouring lines
const minDistance = 0.6 // a line stops when it gets closer than this to another line
const minPoints = 12 // shorter lines are dropped, they only add clutter
const seedSpacing = { contours: 3.5, flow: 1.5 } // grid cell size for seeds
const linkGap = 0.3 // between a link's end and its dot
const hubShare = 0.12 // share of dots that become star-like hubs
const hubReach = 2.5 // how far hub spokes reach, in grid cells
const ownGap = Math.ceil((3 * minDistance) / step) // a line ignores its own points this close along it

function random(seed: number) {
  // mulberry32
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** rasterises where particles may go: inside the region, outside text (grown by clearance) and holes */
function freeMask(input: PatternInput, resolution: number) {
  const columns = Math.ceil(input.width / resolution)
  const rows = Math.ceil(input.height / resolution)
  const canvas = document.createElement('canvas')
  canvas.width = columns
  canvas.height = rows
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.scale(1 / resolution, 1 / resolution)

  const { x1, y1, x2, y2 } = input.region
  context.fillRect(x1, y1, x2 - x1, y2 - y1)

  context.globalCompositeOperation = 'destination-out'
  const text = new Path2D(input.textPath)
  context.fill(text)
  context.lineWidth = 2 * input.clearance
  context.lineJoin = 'round'
  context.stroke(text)
  for (const hole of input.holes) {
    context.beginPath()
    // holes sit on the frame line, so they only keep the line distance
    context.arc(hole.x, hole.y, hole.r + minDistance, 0, 2 * Math.PI)
    context.fill()
  }

  const pixels = context.getImageData(0, 0, columns, rows).data
  return (x: number, y: number) => {
    const column = Math.floor(x / resolution)
    const row = Math.floor(y / resolution)
    if (column < 0 || row < 0 || column >= columns || row >= rows) return false
    return pixels[(row * columns + column) * 4 + 3]! > 127
  }
}

/** a point of a line; `position` counts steps along the line from its seed (negative backwards) */
interface LinePoint { x: number; y: number; line: number; position: number }

/** spatial hash of line points, for keeping lines apart */
class LineGrid {
  private cells = new Map<number, LinePoint[]>()

  private key(x: number, y: number) {
    return Math.floor(y / spacing) * 100000 + Math.floor(x / spacing)
  }

  add(point: LinePoint) {
    const key = this.key(point.x, point.y)
    const cell = this.cells.get(key)
    if (cell) cell.push(point)
    else this.cells.set(key, [point])
  }

  remove(point: LinePoint) {
    const cell = this.cells.get(this.key(point.x, point.y))!
    cell.splice(cell.indexOf(point), 1)
  }

  /** the nearest point of another line, or of a distant part of the same line, closer than `distance` */
  blocking(x: number, y: number, distance: number, line = -1, position = 0) {
    const column = Math.floor(x / spacing)
    const row = Math.floor(y / spacing)
    const reach = Math.ceil(distance / spacing)
    let nearest: LinePoint | undefined
    let nearestDistance = distance ** 2
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        for (const point of this.cells.get((row + dy) * 100000 + column + dx) ?? []) {
          const squared = (point.x - x) ** 2 + (point.y - y) ** 2
          if (squared >= nearestDistance) continue
          if (point.line === line && Math.abs(point.position - position) < ownGap) continue
          nearest = point
          nearestDistance = squared
        }
      }
    }
    return nearest
  }
}

const linePath = (points: LinePoint[]) =>
  'M' + points.map(({ x, y }) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L')

export type Pattern = ReturnType<typeof createPattern>

export function createPattern(input: PatternInput) {
  let finished = '' // path data of completed lines
  let current: { backward: LinePoint[]; forward: LinePoint[] } | undefined // line growing right now
  let partial = '' // network link growing right now
  let done = false

  const currentPoints = () => current ? [...current.backward].reverse().concat(current.forward) : []

  function* grow() {
    const { x1, y1, x2, y2 } = input.region
    if (x2 <= x1 || y2 <= y1) return

    const resolution = Math.max(0.1, Math.sqrt((input.width * input.height) / 2e6))
    const free = freeMask(input, resolution)
    const rand = random(input.seed)
    if (input.style === 'network') {
      yield* growNetwork(free, rand)
      return
    }
    const grid = new LineGrid()

    // two octaves of noise, features scale with the letters
    const noise = createNoise2D(rand)
    const scale = 35 + 6 * input.clearance
    const height = (x: number, y: number) =>
      noise(x / scale, y / scale) + 0.4 * noise((2.3 * x) / scale + 17, (2.3 * y) / scale)

    const contours = input.style === 'contours'
    /** unit vector of the particle's direction, undefined on flat ground */
    const direction = (x: number, y: number, sign: number): [number, number] | undefined => {
      if (!contours) {
        const angle = height(x, y) * Math.PI * 1.5
        return [Math.cos(angle), Math.sin(angle)]
      }
      const e = 0.05
      const gx = height(x + e, y) - height(x - e, y)
      const gy = height(x, y + e) - height(x, y - e)
      const length = Math.hypot(gx, gy)
      if (length < 1e-9) return undefined
      return [(-gy / length) * sign, (gx / length) * sign]
    }

    let lineId = 0
    const candidates: [number, number][] = []

    /** traces a line through a seed: contours in both directions, flow downstream only */
    function* growLine(x: number, y: number) {
      const line = lineId++
      const added: LinePoint[] = []
      current = { backward: [], forward: [] }
      const stamp = (points: LinePoint[], point: LinePoint) => {
        grid.add(point)
        added.push(point)
        points.push(point)
      }
      stamp(current.forward, { x, y, line, position: 0 })

      for (const sign of contours ? [1, -1] : [1]) {
        const points = sign === 1 ? current.forward : current.backward
        let px = x
        let py = y
        for (let position = sign; Math.abs(position) < 4000; position += sign) {
          // midpoint integration keeps tight curves around hilltops on the contour
          const a = direction(px, py, sign)
          if (!a) break
          const b = direction(px + (a[0] * step) / 2, py + (a[1] * step) / 2, sign)
          if (!b) break
          const nx = px + b[0] * step
          const ny = py + b[1] * step
          if (!free(nx, ny)) break
          const hit = grid.blocking(nx, ny, minDistance, line, position)
          if (hit) {
            // a stream joins the one it runs into
            if (!contours) points.push({ x: hit.x, y: hit.y, line, position })
            break
          }
          px = nx
          py = ny
          stamp(points, { x: px, y: py, line, position })
          yield
        }
      }

      const points = currentPoints()
      current = undefined
      if (points.length < minPoints) {
        for (const point of added) grid.remove(point)
        return
      }
      finished += linePath(points)
      if (!contours) return

      // neighbouring contours start one spacing to either side
      for (let i = 2; i < points.length; i += 4) {
        const point = points[i]!
        const along = direction(point.x, point.y, 1)
        if (!along) continue
        for (const side of [-1, 1]) {
          candidates.push([point.x - along[1] * side * spacing, point.y + along[0] * side * spacing])
        }
      }
    }

    // seeds sit on a grid with random offsets, covering the whole region, text included, so
    // they are spread evenly and their number scales with the label;
    // the ones on text or too close to it are dropped before anything grows
    const cell = seedSpacing[contours ? 'contours' : 'flow']
    const seeds: [number, number][] = []
    for (let y = y1; y < y2; y += cell) {
      for (let x = x1; x < x2; x += cell) seeds.push([x + rand() * cell, y + rand() * cell])
    }
    // grow in random order, so the animation doesn't sweep row by row
    for (let i = seeds.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[seeds[i], seeds[j]] = [seeds[j]!, seeds[i]!]
    }
    const freeSeeds = seeds.filter(([x, y]) => free(x, y))

    for (const seed of freeSeeds) {
      candidates.push(seed)
      // fill outwards from each seed before trying the next one
      while (candidates.length) {
        const [x, y] = candidates.shift()!
        if (free(x, y) && !grid.blocking(x, y, contours ? spacing * 0.9 : minDistance)) yield* growLine(x, y)
      }
    }
  }

  /** Gabriel graph of jittered grid dots plus star-like hubs, spreading out from a random dot */
  function* growNetwork(free: (x: number, y: number) => boolean, rand: () => number) {
    const { x1, y1, x2, y2 } = input.region
    const cell = 2.5 + 0.4 * input.clearance // network clearance is a quarter letter height
    const maxRadius = 1.2

    // a dot needs room for its largest size
    const roomy = (x: number, y: number) =>
      free(x, y) && free(x - maxRadius, y) && free(x + maxRadius, y) && free(x, y - maxRadius) && free(x, y + maxRadius)
    /** anchors sit on the region edge (the frame): links end there, no dot is drawn */
    const nodes: { x: number; y: number; links: number[]; radius: number; anchor: boolean }[] = []
    for (let y = y1; y < y2; y += cell) {
      for (let x = x1; x < x2; x += cell) {
        const node = { x: x + (0.15 + 0.7 * rand()) * cell, y: y + (0.15 + 0.7 * rand()) * cell, links: [], radius: 0, anchor: false }
        if (roomy(node.x, node.y)) nodes.push(node)
      }
    }
    const inward = 0.3 // anchors are checked slightly inside the edge, where the mask is reliable
    const along = (from: number, to: number) => {
      const positions: number[] = []
      for (let t = from + cell / 2; t < to - cell / 4; t += cell) positions.push(t + (rand() - 0.5) * 0.6 * cell)
      return positions
    }
    for (const x of along(x1, x2)) {
      if (free(x, y1 + inward)) nodes.push({ x, y: y1, links: [], radius: 0, anchor: true })
      if (free(x, y2 - inward)) nodes.push({ x, y: y2, links: [], radius: 0, anchor: true })
    }
    for (const y of along(y1, y2)) {
      if (free(x1 + inward, y)) nodes.push({ x: x1, y, links: [], radius: 0, anchor: true })
      if (free(x2 - inward, y)) nodes.push({ x: x2, y, links: [], radius: 0, anchor: true })
    }

    const distance = (a: number, b: number) => Math.hypot(nodes[a]!.x - nodes[b]!.x, nodes[a]!.y - nodes[b]!.y)
    const clear = (a: number, b: number) => {
      const samples = Math.ceil(distance(a, b) / 0.3)
      for (let i = 1; i < samples; i++) {
        const t = i / samples
        if (!free(nodes[a]!.x + (nodes[b]!.x - nodes[a]!.x) * t, nodes[a]!.y + (nodes[b]!.y - nodes[a]!.y) * t)) return false
      }
      return true
    }
    const near = nodes.map((_, a) => nodes.map((_, b) => b).filter((b) => b !== a && distance(a, b) < hubReach * cell))
    const link = (a: number, b: number) => {
      if (nodes[a]!.anchor && nodes[b]!.anchor) return
      if (nodes[a]!.links.includes(b) || !clear(a, b)) return
      nodes[a]!.links.push(b)
      nodes[b]!.links.push(a)
    }
    // a and b are linked unless another dot lies in the circle with diameter ab
    near.forEach((neighbours, a) => {
      for (const b of neighbours) {
        if (b < a) continue
        const ab = distance(a, b) ** 2
        if (!neighbours.some((c) => c !== b && distance(a, c) ** 2 + distance(b, c) ** 2 < ab)) link(a, b)
      }
    })
    // hubs reach every dot around them whose spoke doesn't run through another dot
    const passes = (a: number, b: number, c: number) => {
      const ab = distance(a, b)
      const t = ((nodes[c]!.x - nodes[a]!.x) * (nodes[b]!.x - nodes[a]!.x) + (nodes[c]!.y - nodes[a]!.y) * (nodes[b]!.y - nodes[a]!.y)) / ab ** 2
      if (t <= 0 || t >= 1) return false
      const x = nodes[a]!.x + (nodes[b]!.x - nodes[a]!.x) * t
      const y = nodes[a]!.y + (nodes[b]!.y - nodes[a]!.y) * t
      return Math.hypot(nodes[c]!.x - x, nodes[c]!.y - y) < maxRadius + linkGap
    }
    nodes.forEach((_, a) => {
      if (rand() >= hubShare) return
      for (const b of near[a]!) {
        if (!near[a]!.some((c) => c !== b && passes(a, b, c))) link(a, b)
      }
    })
    for (const node of nodes) node.radius = node.anchor ? 0 : Math.min(maxRadius, 0.15 + 0.1 * node.links.length)

    const dot = (node: (typeof nodes)[number]) => {
      if (node.anchor) return ''
      const { x, y, radius: r } = node
      return `M${(x - r).toFixed(2)} ${y.toFixed(2)}A${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(x + r).toFixed(2)} ${y.toFixed(2)}` +
        `A${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(x - r).toFixed(2)} ${y.toFixed(2)}`
    }

    // spread out breadth first, starting each separate part of the network at a random dot
    const visited = new Set<number>()
    const linked = new Set<string>()
    const order = nodes.map((_, index) => index)
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[order[i], order[j]] = [order[j]!, order[i]!]
    }
    for (const start of order) {
      if (visited.has(start) || nodes[start]!.links.length === 0) continue
      visited.add(start)
      finished += dot(nodes[start]!)
      const queue = [start]
      while (queue.length) {
        const a = queue.shift()!
        for (const b of nodes[a]!.links) {
          const key = a < b ? `${a}-${b}` : `${b}-${a}`
          if (linked.has(key)) continue
          linked.add(key)

          // the link runs from dot edge to dot edge
          const from = nodes[a]!
          const to = nodes[b]!
          const length = distance(a, b)
          const dx = (to.x - from.x) / length
          const dy = (to.y - from.y) / length
          const begin = from.anchor ? 0 : from.radius + linkGap
          const end = length - (to.anchor ? 0 : to.radius + linkGap)
          const segment = (until: number) =>
            `M${(from.x + dx * begin).toFixed(2)} ${(from.y + dy * begin).toFixed(2)}` +
            `L${(from.x + dx * until).toFixed(2)} ${(from.y + dy * until).toFixed(2)}`
          for (let along = begin + step; along < end; along += step) {
            partial = segment(along)
            yield
          }
          partial = ''
          if (end > begin) finished += segment(end)

          if (!visited.has(b)) {
            visited.add(b)
            finished += dot(to)
            queue.push(b)
          }
        }
      }
    }
  }

  const growth = grow()
  return {
    /** grows by up to `steps` particle steps; returns true once the pattern is complete */
    advance(steps: number) {
      for (let i = 0; i < steps && !done; i++) done = !!growth.next().done
      return done
    },
    /** SVG path data of everything grown so far */
    path() {
      const points = currentPoints()
      return finished + partial + (points.length >= 2 ? linePath(points) : '')
    },
  }
}
