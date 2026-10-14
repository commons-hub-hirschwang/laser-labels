import { parse, type Font, type Glyph, type Path } from 'opentype.js'
import latinUrl from '@fontsource/fira-sans/files/fira-sans-latin-500-normal.woff?url'
import latinExtUrl from '@fontsource/fira-sans/files/fira-sans-latin-ext-500-normal.woff?url'
import type { PatternInput, PatternStyle } from './pattern'
import { qrModules } from './qr'

// All geometry is in millimetres.

export type HoleMode = 'none' | 'top' | 'sides' | 'corners'
export type HoleAlign = 'top' | 'middle'
export type HoleSide = 'top' | 'right' | 'bottom' | 'left'
export type QrPosition = 'none' | 'left' | 'right' | 'top' | 'bottom'

export interface LabelOptions {
  text: string
  /** cap height of the letters */
  textSize: number
  /** space around the text, relative to the letter height */
  padding: number
  holes: HoleMode
  /** side for the single hole */
  holeSide: HoleSide
  /** only used for holes === 'sides' */
  holeAlign: HoleAlign
  holeDiameter: number
  /** thin engraved frame inside the label edge */
  frame: boolean
  /** thin second line inside the frame, drawn over the pattern */
  innerLine: boolean
  /** particle pattern around the text */
  pattern: PatternStyle | 'none'
  patternSeed: number
  /** beside the text; without text the label holds only the QR code */
  qrPosition: QrPosition
  /** usually a URL */
  qrContent: string
  /** side length without quiet zone */
  qrSize: number
}

export interface Label {
  width: number
  height: number
  textPath: string
  framePath: string
  /** grown separately (and animated) by createPattern */
  pattern?: PatternInput
  cutPath: string
  holes: { x: number; y: number; r: number }[]
  /** dark QR modules, engraved like the text */
  qrPath: string
  qr?: { modules: number; moduleSize: number }
  qrError?: string
}

const edgeMargin = 1.5 // between label edge, frame, holes and text
const frameWidth = 2
// distance of the frame's centre line from the label edge, fixed so holes don't change it
const frameInset = 5.5
const innerLineWidth = 0.5
const innerLineGap = 1.5 // wood between frame and inner line
const lineHeightFactor = 1.2
const minSize = 10
/** light modules around a QR code, kept free of pattern and edges */
const qrQuietModules = 2
/** half the engrave stroke width (see toSvg): QR modules shrink by it so they burn at their size */
const strokeHalf = 0.05

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

/**
 * Replaces path.toPathData: its rounding writes NaN for values within float noise of an
 * integer (it parses strings like "3.5e-15e+3"), which breaks the whole path.
 */
function pathData(path: Path) {
  return path.commands.map((command) => {
    switch (command.type) {
      case 'M':
      case 'L': return `${command.type}${round(command.x)} ${round(command.y)}`
      case 'Q': return `Q${round(command.x1)} ${round(command.y1)} ${round(command.x)} ${round(command.y)}`
      case 'C': return `C${round(command.x1)} ${round(command.y1)} ${round(command.x2)} ${round(command.y2)} ${round(command.x)} ${round(command.y)}`
      case 'Z': return 'Z'
    }
  }).join('')
}

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

  let qrModulesGrid: boolean[][] | undefined
  let qrError: string | undefined
  if (options.qrPosition !== 'none' && options.qrContent.trim()) {
    try {
      qrModulesGrid = qrModules(options.qrContent.trim())
    } catch {
      qrError = 'Too long for a QR code'
    }
  }
  const moduleSize = qrModulesGrid ? options.qrSize / qrModulesGrid.length : 0
  const quietZone = qrQuietModules * moduleSize

  // without text the QR code sets the scale that the padding refers to
  const scale = ink || !qrModulesGrid ? options.textSize : options.qrSize / 5
  // the pattern keeps half a letter height away from the text, so it only shows above 0.5
  const padding = Math.max(1.5, scale * options.padding, quietZone)

  // the QR code sits beside the text, centred on it, one padding away
  const content = { ...text }
  let qrBox: { x1: number; y1: number; x2: number; y2: number } | undefined
  if (qrModulesGrid) {
    const size = options.qrSize
    const middle = { x: (text.x1 + text.x2) / 2, y: (text.y1 + text.y2) / 2 }
    const position = ink ? options.qrPosition : 'none'
    const x1 = position === 'left' ? text.x1 - padding - size : position === 'right' ? text.x2 + padding : middle.x - size / 2
    const y1 = position === 'top' ? text.y1 - padding - size : position === 'bottom' ? text.y2 + padding : middle.y - size / 2
    qrBox = { x1, y1, x2: x1 + size, y2: y1 + size }
    if (ink) {
      content.x1 = Math.min(text.x1, qrBox.x1)
      content.y1 = Math.min(text.y1, qrBox.y1)
      content.x2 = Math.max(text.x2, qrBox.x2)
      content.y2 = Math.max(text.y2, qrBox.y2)
    } else {
      Object.assign(content, qrBox)
    }
  }
  const r = options.holeDiameter / 2
  const holeEdge = Math.max(3, options.holeDiameter) // wood between hole and label edge
  const frameHalf = frameWidth / 2
  const frameOuter = frameInset - frameHalf // outer edge of the frame
  const frameInner = frameInset + frameHalf // inner edge of the frame
  // hole centre distance from edge: holes touch the frame's outer edge from inside
  const c = options.frame ? frameOuter + r : holeEdge + r
  const hasHoles = options.holes !== 'none'

  // distance from each label edge to the padded text area
  const inset = { left: edgeMargin, right: edgeMargin, top: edgeMargin, bottom: edgeMargin }
  if (options.frame) {
    const value = Math.max(frameInner, hasHoles ? frameOuter + 2 * r : 0) + edgeMargin
    inset.left = inset.right = inset.top = inset.bottom = value
  } else {
    const holeZone = c + r + edgeMargin
    if (options.holes === 'top') inset[options.holeSide] = holeZone
    if (options.holes === 'sides' || options.holes === 'corners') inset.left = inset.right = holeZone
  }

  let width = content.x2 - content.x1 + 2 * padding + inset.left + inset.right
  let height = content.y2 - content.y1 + 2 * padding + inset.top + inset.bottom
  if (options.holes === 'corners') height = Math.max(height, 2 * (c + r) + holeEdge)
  width = Math.max(width, minSize)
  height = Math.max(height, minSize)

  // centre text and QR code inside the area not reserved for holes and frame
  const dx = inset.left + (width - inset.left - inset.right) / 2 - (content.x1 + content.x2) / 2
  const dy = inset.top + (height - inset.top - inset.bottom) / 2 - (content.y1 + content.y2) / 2
  for (const path of paths) translate(path, dx, dy)

  // one rectangle per run of dark modules in a row, narrowed so the stroke doesn't widen it
  let qrPath = ''
  if (qrModulesGrid && qrBox) {
    const left = qrBox.x1 + dx
    const top = qrBox.y1 + dy
    qrModulesGrid.forEach((row, rowIndex) => {
      let start = -1
      row.concat(false).forEach((dark, column) => {
        if (dark && start < 0) start = column
        if (!dark && start >= 0) {
          const [x1, x2] = [left + start * moduleSize + strokeHalf, left + column * moduleSize - strokeHalf].map(round)
          const [y1, y2] = [top + rowIndex * moduleSize, top + (rowIndex + 1) * moduleSize].map(round)
          qrPath += `M${x1} ${y1}H${x2}V${y2}H${x1}Z`
          start = -1
        }
      })
    })
  }

  let framePath = ''
  // the cut line is rounded around the frame's corners, also when there is no frame
  const outlineRadius = Math.min(frameInner, width / 2, height / 2)
  if (options.frame) {
    // square inner corners; the outer edge and the label's cut line are rounded around them
    const outer = frameOuter
    framePath = roundedRect(outer, outer, width - 2 * outer, height - 2 * outer, frameWidth) +
      roundedRect(frameInner, frameInner, width - 2 * frameInner, height - 2 * frameInner, 0)
    if (options.innerLine) {
      // inside the frame without adding margin
      const half = innerLineWidth / 2
      const centre = frameInner + innerLineGap + half
      // square inner corners like the frame's
      framePath +=
        roundedRect(centre - half, centre - half, width - 2 * (centre - half), height - 2 * (centre - half), innerLineWidth) +
        roundedRect(centre + half, centre + half, width - 2 * (centre + half), height - 2 * (centre + half), 0)
    }
  }

  const singleHole = {
    top: { x: width / 2, y: c },
    right: { x: width - c, y: height / 2 },
    bottom: { x: width / 2, y: height - c },
    left: { x: c, y: height / 2 },
  }[options.holeSide]
  const holeList = {
    none: [],
    top: [singleHole],
    sides: [
      { x: c, y: options.holeAlign === 'top' ? c : height / 2 },
      { x: width - c, y: options.holeAlign === 'top' ? c : height / 2 },
    ],
    corners: [
      { x: c, y: c }, { x: width - c, y: c },
      { x: c, y: height - c }, { x: width - c, y: height - c },
    ],
  }[options.holes].map((hole) => ({ x: round(hole.x), y: round(hole.y), r }))

  const textPath = paths.map(pathData).join('')
  const regionInset = options.frame ? frameInner : edgeMargin
  const pattern = options.pattern !== 'none'
    ? {
      style: options.pattern,
      width,
      height,
      region: { x1: regionInset, y1: regionInset, x2: width - regionInset, y2: height - regionInset },
      // inside a frame the corners are square
      regionRadius: options.frame ? 0 : Math.max(0, outlineRadius - regionInset),
      textPath,
      holes: holeList,
      keepOut: qrBox
        ? [{ x1: qrBox.x1 + dx - quietZone, y1: qrBox.y1 + dy - quietZone, x2: qrBox.x2 + dx + quietZone, y2: qrBox.y2 + dy + quietZone }]
        : [],
      // the network's dots read as separate from the letters even when close
      clearance: options.textSize * (options.pattern === 'network' ? 0.25 : 0.5),
      seed: options.patternSeed,
    }
    : undefined

  width = round(width)
  height = round(height)
  return {
    width,
    height,
    textPath,
    framePath,
    pattern,
    cutPath: roundedRect(0, 0, width, height, outlineRadius) + holeList.map((h) => circle(h.x, h.y, h.r)).join(''),
    holes: holeList,
    qrPath,
    qr: qrModulesGrid && { modules: qrModulesGrid.length, moduleSize },
    qrError,
  }
}

/**
 * Laser convention: red hairline = cut, black = engrave, blue = pattern (single lines,
 * its own layer so it can get a lighter setting). xTool Studio / XCS create layers by
 * stroke colour, so the text also gets a black stroke.
 */
export function toSvg(label: Label, patternPath: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${label.width}mm" height="${label.height}mm" viewBox="0 0 ${label.width} ${label.height}">
  <path id="engrave" d="${label.textPath}${label.qrPath}" fill="#000000" stroke="#000000" stroke-width="0.1"/>${label.framePath ? `
  <path id="frame" d="${label.framePath}" fill="#000000" fill-rule="evenodd" stroke="#000000" stroke-width="0.1"/>` : ''}${patternPath ? `
  <path id="pattern" d="${patternPath}" fill="none" stroke="#0000FF" stroke-width="0.1"/>` : ''}
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
