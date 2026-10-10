import { parse, type Font, type Glyph, type Path } from 'opentype.js'
import latinUrl from '@fontsource/source-sans-3/files/source-sans-3-latin-600-normal.woff?url'
import latinExtUrl from '@fontsource/source-sans-3/files/source-sans-3-latin-ext-600-normal.woff?url'

// All geometry is in millimetres.

export type HoleMode = 'none' | 'top' | 'sides' | 'corners'
export type HoleAlign = 'top' | 'middle'

export interface LabelOptions {
  text: string
  /** cap height of the letters */
  textSize: number
  holes: HoleMode
  /** only used for holes === 'sides' */
  holeAlign: HoleAlign
  holeDiameter: number
  /** thin engraved frame inside the label edge */
  frame: boolean
}

export interface Label {
  width: number
  height: number
  textPath: string
  framePath: string
  cutPath: string
  holes: { x: number; y: number; r: number }[]
}

const cornerRadius = 1.5
const edgeMargin = 1.5 // between label edge, frame, holes and text
const frameWidth = 2
const frameRadius = 1.5 // of the frame's centre line
const lineHeightFactor = 1.2
const minSize = 10

// Fontsource splits fonts by unicode range; the first font containing a glyph wins.
let fonts: Font[] = []

export async function loadFonts() {
  fonts = await Promise.all(
    [latinUrl, latinExtUrl].map(async (url) => parse(await (await fetch(url)).arrayBuffer())),
  )
}

function fontFor(char: string) {
  return fonts.find((font) => font.charToGlyphIndex(char) > 0) ?? fonts[0]!
}

/**
 * Places glyphs manually instead of using font.getPath: opentype.js 2.0 always applies
 * the ccmp feature and crashes on the lookup tables of some fonts.
 */
function linePath(line: string, baseline: number, fontSize: number) {
  const paths: Path[] = []
  let x = 0
  let previous: { font: Font; glyph: Glyph } | undefined
  for (const char of line) {
    const font = fontFor(char)
    const glyph = font.charToGlyph(char)
    const scale = fontSize / font.unitsPerEm
    if (previous?.font === font) x += font.getKerningValue(previous.glyph, glyph) * scale
    paths.push(glyph.getPath(x, baseline, fontSize))
    x += (glyph.advanceWidth ?? 0) * scale
    previous = { font, glyph }
  }
  return paths
}

function bounds(paths: Path[]) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const path of paths) {
    if (path.commands.length === 0) continue
    const box = path.getBoundingBox()
    x1 = Math.min(x1, box.x1)
    y1 = Math.min(y1, box.y1)
    x2 = Math.max(x2, box.x2)
    y2 = Math.max(y2, box.y2)
  }
  return x1 === Infinity ? undefined : { x1, y1, x2, y2 }
}

function translate(path: Path, dx: number, dy: number) {
  for (const command of path.commands) {
    if ('x' in command) { command.x += dx; command.y += dy }
    if ('x1' in command) { command.x1 += dx; command.y1 += dy }
    if ('x2' in command) { command.x2 += dx; command.y2 += dy }
  }
}

function roundedRect(x: number, y: number, w: number, h: number, r: number) {
  const [x1, y1, x2, y2] = [x, y, x + w, y + h].map(round) as [number, number, number, number]
  return `M${x1 + r} ${y1}H${x2 - r}A${r} ${r} 0 0 1 ${x2} ${y1 + r}V${y2 - r}A${r} ${r} 0 0 1 ${x2 - r} ${y2}` +
    `H${x1 + r}A${r} ${r} 0 0 1 ${x1} ${y2 - r}V${y1 + r}A${r} ${r} 0 0 1 ${x1 + r} ${y1}Z`
}

function circle(x: number, y: number, r: number) {
  return `M${x - r} ${y}A${r} ${r} 0 1 0 ${x + r} ${y}A${r} ${r} 0 1 0 ${x - r} ${y}Z`
}

const round = (value: number) => Math.round(value * 1000) / 1000

export function layoutLabel(options: LabelOptions): Label {
  const font = fonts[0]!
  const capHeight = font.tables.os2!.sCapHeight / font.unitsPerEm
  const fontSize = options.textSize / capHeight
  const lineHeight = fontSize * lineHeightFactor

  // lay out lines centred on x = 0, first baseline at y = 0
  const lines = options.text.replace(/\s+$/, '').split('\n')
  const paths: Path[] = []
  lines.forEach((line, index) => {
    const linePaths = linePath(line.trim(), index * lineHeight, fontSize)
    const box = bounds(linePaths)
    if (!box) return
    for (const path of linePaths) translate(path, -(box.x1 + box.x2) / 2, 0)
    paths.push(...linePaths)
  })

  // vertical extent at least cap height to baseline, so similar labels get equal heights
  const ink = bounds(paths)
  const lastBaseline = (lines.length - 1) * lineHeight
  const text = {
    x1: ink?.x1 ?? 0,
    x2: ink?.x2 ?? 0,
    y1: Math.min(ink?.y1 ?? 0, -options.textSize),
    y2: Math.max(ink?.y2 ?? 0, lastBaseline),
  }

  const padding = Math.max(1.5, options.textSize * 0.35)
  const r = options.holeDiameter / 2
  const holeEdge = Math.max(3, options.holeDiameter) // wood between hole and label edge
  const c = holeEdge + r // hole centre distance from edge
  const hasHoles = options.holes !== 'none'

  // distance from each label edge to the padded text area
  const inset = { left: edgeMargin, right: edgeMargin, top: edgeMargin, bottom: edgeMargin }
  const frameHalf = frameWidth / 2
  // the frame's centre line runs through the hole centres, at the same inset on all sides
  const frameCentre = hasHoles ? c : edgeMargin + frameHalf
  if (options.frame) {
    const value = frameCentre + Math.max(frameHalf, hasHoles ? r : 0) + edgeMargin
    inset.left = inset.right = inset.top = inset.bottom = value
  } else {
    const holeZone = c + r + edgeMargin
    if (options.holes === 'top') inset.top = holeZone
    if (options.holes === 'sides' || options.holes === 'corners') inset.left = inset.right = holeZone
  }

  let width = text.x2 - text.x1 + 2 * padding + inset.left + inset.right
  let height = text.y2 - text.y1 + 2 * padding + inset.top + inset.bottom
  if (options.holes === 'corners') height = Math.max(height, 2 * (c + r) + holeEdge)
  width = Math.max(width, minSize)
  height = Math.max(height, minSize)

  // centre text inside the area not reserved for holes and frame
  const dx = inset.left + (width - inset.left - inset.right) / 2 - (text.x1 + text.x2) / 2
  const dy = inset.top + (height - inset.top - inset.bottom) / 2 - (text.y1 + text.y2) / 2
  for (const path of paths) translate(path, dx, dy)

  let framePath = ''
  if (options.frame) {
    const outer = frameCentre - frameHalf
    const inner = frameCentre + frameHalf
    // a rounded centre line would miss holes sitting in the corners
    const cornerHoles = options.holes === 'corners' || (options.holes === 'sides' && options.holeAlign === 'top')
    const radius = cornerHoles ? 0 : frameRadius
    framePath = roundedRect(outer, outer, width - 2 * outer, height - 2 * outer, radius + frameHalf) +
      roundedRect(inner, inner, width - 2 * inner, height - 2 * inner, Math.max(0, radius - frameHalf))
  }

  const holes = {
    none: [],
    top: [{ x: width / 2, y: c }],
    sides: [
      { x: c, y: options.holeAlign === 'top' ? c : height / 2 },
      { x: width - c, y: options.holeAlign === 'top' ? c : height / 2 },
    ],
    corners: [
      { x: c, y: c }, { x: width - c, y: c },
      { x: c, y: height - c }, { x: width - c, y: height - c },
    ],
  }[options.holes].map((hole) => ({ x: round(hole.x), y: round(hole.y), r }))

  width = round(width)
  height = round(height)
  return {
    width,
    height,
    textPath: paths.map((path) => path.toPathData(3)).join(''),
    framePath,
    cutPath: roundedRect(0, 0, width, height, cornerRadius) + holes.map((h) => circle(h.x, h.y, h.r)).join(''),
    holes,
  }
}

/**
 * Laser convention: red hairline = cut, black = engrave.
 * xTool Studio / XCS create layers by stroke colour, so the text also gets a black stroke.
 */
export function toSvg(label: Label) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${label.width}mm" height="${label.height}mm" viewBox="0 0 ${label.width} ${label.height}">
  <path id="engrave" d="${label.textPath}" fill="#000000" stroke="#000000" stroke-width="0.1"/>${label.framePath ? `
  <path id="frame" d="${label.framePath}" fill="#000000" fill-rule="evenodd" stroke="#000000" stroke-width="0.1"/>` : ''}
  <path id="cut" d="${label.cutPath}" fill="none" stroke="#FF0000" stroke-width="0.1"/>
</svg>
`
}

export function fileName(text: string) {
  const slug = text.trim().split('\n')[0]!.toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `label-${slug || 'empty'}.svg`
}
