<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { generateFrameJob, generateJob } from './gcode'
import type { Label } from './label'
import { bed, deviceStates, focusZ, material, plywoodSettings, type LaserSettings } from './machine'
import type { Point } from './pathGeometry'
import { S1, serialSupported } from './s1'

// Web Serial only exists on https or localhost
const serialMissing = !serialSupported && (window.isSecureContext
  ? 'Sending to the laser needs a browser with Web Serial, e.g. an up-to-date Chrome or Edge on a computer. ' +
    'Firefox and Safari don\'t support it.'
  : 'Sending to the laser needs a secure connection (https) for Web Serial. Open this page via https.')

const props = defineProps<{
  label: Label
  text: string
  /** finishes the pattern and returns its path data */
  finishPattern: () => string
  /** downloads the current SVG assembled by the parent */
  downloadSvg: () => void
}>()

// storage may be unavailable (private mode, blocked site data); the page works without it
function load<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(key)
    return stored ? { ...fallback, ...JSON.parse(stored) } : fallback
  } catch {
    return fallback
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // not saved
  }
}

const settings = reactive<LaserSettings>(load('laser-settings', structuredClone(plywoodSettings)))
watch(settings, () => save('laser-settings', settings))
const resetSettings = () => Object.assign(settings, structuredClone(plywoodSettings))

const layers = [
  { key: 'engrave', name: 'Engraving', maxSpeed: 400 },
  { key: 'pattern', name: 'Pattern', maxSpeed: 400 },
  { key: 'cut', name: 'Cut', maxSpeed: 50 },
] as const
const settingsChanged = computed(() => layers.some(({ key }) =>
  settings[key].power !== plywoodSettings[key].power || settings[key].speed !== plywoodSettings[key].speed) ||
  settings.lineSpacing !== plywoodSettings.lineSpacing)
const plywoodConfirmed = ref(false)
watch(settingsChanged, () => (plywoodConfirmed.value = false))

// label position on the bed (top-left corner)
const position = reactive<Point>(load('laser-position', { x: 3.7, y: 229 }))
watch(position, () => save('laser-position', position))
const fitsBed = computed(() => props.label.width <= bed.width && props.label.height <= bed.height)
const positionFitsBed = computed(() => fitsBed.value && position.x >= 0 && position.y >= 0 &&
  position.x + props.label.width <= bed.width && position.y + props.label.height <= bed.height)
function clampPosition() {
  Object.assign(position, constrained(position))
}
function setPosition(axis: keyof Point, event: Event) {
  const value = (event.target as HTMLInputElement).valueAsNumber
  if (Number.isFinite(value)) position[axis] = value
  clampPosition()
}
watch(() => [props.label.width, props.label.height], clampPosition, { immediate: true })
const clearBoardCorner = computed(() => {
  const centerX = position.x + props.label.width / 2
  const centerY = position.y + props.label.height / 2
  if (centerY < bed.height / 2) return centerX < bed.width / 2 ? 'bottom-right' : 'bottom-left'
  return centerX < bed.width / 2 ? 'top-right' : 'top-left'
})

interface CutLabel { text: string; cutPath: string; x: number; y: number; width: number; height: number; date: string }
const history = ref<CutLabel[]>(load<{ labels: CutLabel[] }>('laser-history', { labels: [] }).labels)
watch(history, () => save('laser-history', { labels: history.value }), { deep: true })

// removing an old label takes two clicks: the first arms it (crossed out), a click anywhere else defuses
const armed = ref<string>()
function clickCut(cut: CutLabel) {
  if (armed.value === cut.date) history.value = history.value.filter((other) => other !== cut)
  else armed.value = cut.date
}
const defuse = () => (armed.value = undefined)
document.addEventListener('click', defuse)
onBeforeUnmount(() => document.removeEventListener('click', defuse))

const overlaps = computed(() => history.value.some((cut) =>
  position.x < cut.x + cut.width && cut.x < position.x + props.label.width &&
  position.y < cut.y + cut.height && cut.y < position.y + props.label.height))

// dragging the label on the bed map
const bedMap = ref<SVGSVGElement>()
let dragStart: { pointer: Point; position: Point } | undefined
function bedPoint(event: PointerEvent): Point {
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(bedMap.value!.getScreenCTM()!.inverse())
  return { x: point.x, y: point.y }
}
function startDrag(event: PointerEvent) {
  (event.target as Element).setPointerCapture(event.pointerId)
  dragStart = { pointer: bedPoint(event), position: { ...position } }
}
function drag(event: PointerEvent) {
  if (!dragStart) return
  const point = bedPoint(event)
  const next = {
    x: dragStart.position.x + point.x - dragStart.pointer.x,
    y: dragStart.position.y + point.y - dragStart.pointer.y,
  }
  Object.assign(position, constrained(event.shiftKey ? next : snap(next)))
}

function constrained(point: Point): Point {
  const clampAxis = (value: number, max: number) => Math.min(
    Math.max(Math.round(value * 100) / 100, 0),
    Math.floor(Math.max(0, max) * 100) / 100,
  )
  return {
    x: clampAxis(point.x, bed.width - props.label.width),
    y: clampAxis(point.y, bed.height - props.label.height),
  }
}

/** wood left between cut lines when snapping */
const snapGap = 2
const snapDistance = 3

/** Pick a nearby free placement; if the bed is full, minimize the overlap area. */
function nextLabelPosition(origin: Point): Point {
  const maxX = Math.max(0, bed.width - props.label.width)
  const maxY = Math.max(0, bed.height - props.label.height)
  const xs = new Set([0, maxX])
  const ys = new Set([0, maxY])
  const addCandidate = (values: Set<number>, value: number, max: number) => {
    if (value >= 0 && value <= max) values.add(Math.round(value * 10) / 10)
  }
  for (const cut of history.value) {
    addCandidate(xs, cut.x, maxX)
    addCandidate(xs, cut.x + cut.width + snapGap, maxX)
    addCandidate(xs, cut.x - props.label.width - snapGap, maxX)
    addCandidate(ys, cut.y, maxY)
    addCandidate(ys, cut.y + cut.height + snapGap, maxY)
    addCandidate(ys, cut.y - props.label.height - snapGap, maxY)
  }

  let best: Point = { x: origin.x, y: origin.y }
  let bestOverlap = Infinity
  let bestDistance = Infinity
  for (const x of xs) for (const y of ys) {
    let overlapArea = 0
    for (const cut of history.value) {
      const overlapWidth = Math.max(0, Math.min(x + props.label.width, cut.x + cut.width) - Math.max(x, cut.x))
      const overlapHeight = Math.max(0, Math.min(y + props.label.height, cut.y + cut.height) - Math.max(y, cut.y))
      overlapArea += overlapWidth * overlapHeight
    }
    const distance = (x - origin.x) ** 2 + (y - origin.y) ** 2
    if (overlapArea < bestOverlap || (overlapArea === bestOverlap && distance < bestDistance)) {
      best = { x, y }
      bestOverlap = overlapArea
      bestDistance = distance
    }
  }
  return constrained(best)
}

/**
 * Snaps to 2 mm beside earlier labels and the bed edges, or in line with earlier labels' edges.
 * X and Y snap independently, to the closest candidate.
 */
function snap(raw: Point): Point {
  const { width, height } = props.label
  const result = { ...raw }
  const best = { x: snapDistance, y: snapDistance }
  const consider = (axis: 'x' | 'y', candidate: number) => {
    const distance = Math.abs(candidate - raw[axis])
    if (distance < best[axis]) {
      best[axis] = distance
      result[axis] = candidate
    }
  }
  consider('x', snapGap)
  consider('x', bed.width - snapGap - width)
  consider('y', snapGap)
  consider('y', bed.height - snapGap - height)
  for (const cut of history.value) {
    // beside a label only when level with it
    if (raw.y < cut.y + cut.height + snapGap && cut.y < raw.y + height + snapGap) {
      consider('x', cut.x + cut.width + snapGap)
      consider('x', cut.x - snapGap - width)
    }
    if (raw.x < cut.x + cut.width + snapGap && cut.x < raw.x + width + snapGap) {
      consider('y', cut.y + cut.height + snapGap)
      consider('y', cut.y - snapGap - height)
    }
    consider('x', cut.x)
    consider('x', cut.x + cut.width - width)
    consider('y', cut.y)
    consider('y', cut.y + cut.height - height)
  }
  return result
}
const endDrag = () => (dragStart = undefined)

// machine
const s1 = ref<S1>()
const state = ref<number>()
const head = ref<Point>()
const crossOffset = ref<Point>({ x: 0, y: 0 })
const progress = ref<number>()
const error = ref('')
/** job uploaded, the S1 waits for its button */
const waitingForButton = ref(false)
/** the label just sent, added to the history once the S1 starts it */
let sent: CutLabel | undefined
const activeJob = ref<'label' | 'framing'>()

const stateText = computed(() => {
  if (progress.value !== undefined) return `Uploading… ${Math.round(progress.value * 100)} %`
  if (state.value === undefined) return 'Connected'
  if (state.value === 14 && activeJob.value === 'framing') return 'Framing…'
  return deviceStates[state.value] ?? `State ${state.value}`
})

async function connect() {
  error.value = ''
  try {
    const machine = await S1.connect()
    machine.onState = (value) => {
      state.value = value
      if (value === 3 || value === 19) activeJob.value = undefined
      if (value === 14) {
        waitingForButton.value = false
        if (sent) {
          history.value.push(sent)
          Object.assign(position, nextLabelPosition(position))
        }
        sent = undefined
      }
    }
    machine.onPosition = (value) => (head.value = value)
    machine.onClose = () => {
      s1.value = undefined
      state.value = undefined
      waitingForButton.value = false
      activeJob.value = undefined
    }
    s1.value = machine
    crossOffset.value = await machine.crossOffset()
    state.value = await machine.state()
  } catch (reason) {
    if ((reason as Error).name !== 'NotFoundError') error.value = (reason as Error).message // NotFoundError: dialog closed
  }
}
onBeforeUnmount(() => void s1.value?.close())

const corners = computed(() => {
  const { width, height } = props.label
  return [
    { name: 'top left', symbol: '↖', x: position.x, y: position.y },
    { name: 'top right', symbol: '↗', x: position.x + width, y: position.y },
    { name: 'bottom left', symbol: '↙', x: position.x, y: position.y + height },
    { name: 'bottom right', symbol: '↘', x: position.x + width, y: position.y + height },
  ]
})

/** moves the head so its red cross points at the corner */
async function showCorner(corner: Point) {
  error.value = ''
  const target = { x: corner.x - crossOffset.value.x, y: corner.y - crossOffset.value.y }
  const reachable = { x: Math.min(Math.max(target.x, 0), bed.width), y: Math.min(Math.max(target.y, 0), bed.height) }
  if (reachable.x !== target.x || reachable.y !== target.y) error.value = 'The cross cannot reach this corner, it stops at the edge.'
  await s1.value!.moveTo(reachable)
}

const canFrame = computed(() => s1.value && positionFitsBed.value && state.value === 3 && progress.value === undefined)
const canMoveCross = computed(() => s1.value && positionFitsBed.value && state.value === 3 && progress.value === undefined)

async function frameLabel() {
  error.value = ''
  activeJob.value = 'framing'
  try {
    const headPosition = head.value ?? await s1.value!.position()
    const uploaded = await uploadJob(generateFrameJob({
      position,
      width: props.label.width,
      height: props.label.height,
      head: headPosition,
    }))
    if (!uploaded) activeJob.value = undefined
  } catch (reason) {
    activeJob.value = undefined
    error.value = (reason as Error).message
  }
}

function job() {
  return generateJob({
    textPath: props.label.textPath + props.label.qrPath,
    framePath: props.label.framePath,
    patternPath: props.finishPattern(),
    cutPath: props.label.cutPath,
    position,
    settings,
    head: head.value ?? { x: 29.6, y: 216.78 },
  })
}

const canSend = computed(() => s1.value && positionFitsBed.value &&
  (settingsChanged.value || plywoodConfirmed.value) && state.value === 3 && progress.value === undefined)

async function send() {
  error.value = ''
  const { width, height, cutPath } = props.label
  activeJob.value = 'label'
  if (await uploadJob(job())) {
    sent = { text: props.text.trim().split('\n')[0]!, cutPath, x: position.x, y: position.y, width, height, date: new Date().toISOString() }
    plywoodConfirmed.value = false // asked again for every label
  } else activeJob.value = undefined
}

async function uploadJob(gcode: string) {
  error.value = ''
  progress.value = 0
  try {
    await s1.value!.sendJob(gcode, (fraction) => (progress.value = fraction))
    waitingForButton.value = true
    return true
  } catch (reason) {
    error.value = (reason as Error).message
    return false
  } finally {
    progress.value = undefined
  }
}

function downloadGcode() {
  download('tmp.gcode', job())
}

function download(filename: string, gcode: string) {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([gcode], { type: 'text/plain' }))
  link.download = filename
  link.click()
  URL.revokeObjectURL(link.href)
}
</script>

<template>
  <form class="laser" @submit.prevent>
    <h2>Laser Cutting</h2>
    <p class="machine-note">Designed for the <strong>40W xTool S1</strong>, with defaults tuned for <strong>{{ material }}</strong>.</p>

    <details class="settings-override">
      <summary>Override default settings</summary>
      <p class="settings-guidance">
        Defaults are for <strong>{{ material }}</strong> only. Focus height (Z {{ focusZ }}) was measured on it;
        power, speed, and vertical distance are tuned for it. For other materials, use xTool Studio.
        Change these settings only if you know what you’re doing.
      </p>
      <fieldset v-for="layer in layers" :key="layer.key" class="layer">
        <legend>{{ layer.name }}</legend>
        <label>
          Power: {{ settings[layer.key].power }} %
          <input v-model.number="settings[layer.key].power" type="range" min="1" max="100" step="1" />
        </label>
        <label>
          Speed: {{ settings[layer.key].speed }} mm/s
          <input v-model.number="settings[layer.key].speed" type="range" min="1" :max="layer.maxSpeed" step="1" />
        </label>
      </fieldset>
      <label class="vertical-distance">
        Vertical distance: {{ settings.lineSpacing.toFixed(2) }} mm
        <input v-model.number="settings.lineSpacing" type="range" min="0.05" max="0.5" step="0.01" />
      </label>
      <div class="actions">
        <button type="button" class="secondary" @click="resetSettings">Reset to {{ material }} settings</button>
      </div>
    </details>

    <fieldset>
      <legend>Drag the label to position it on the bed</legend>
      <div class="bed-map-wrapper">
        <svg
          ref="bedMap"
          class="bed"
          :viewBox="`-2 -2 ${bed.width + 4} ${bed.height + 4}`"
          @pointermove="drag"
          @pointerup="endDrag"
          @pointercancel="endDrag"
        >
          <rect class="area" :width="bed.width" :height="bed.height" />
          <g
            v-for="cut in history"
            :key="cut.date"
            class="cut-before"
            :class="{ armed: armed === cut.date }"
            :transform="`translate(${cut.x} ${cut.y})`"
            @click.stop="clickCut(cut)"
          >
            <title>
              {{ cut.text }}, {{ new Date(cut.date).toLocaleDateString() }} –
              {{ armed === cut.date ? 'click again to remove' : 'click to remove' }}
            </title>
            <path :d="cut.cutPath" />
            <path
              v-if="armed === cut.date"
              class="cross"
              pathLength="100"
              :d="`M${cut.width * 0.125} ${cut.height * 0.125}L${cut.width * 0.875} ${cut.height * 0.875}M${cut.width * 0.875} ${cut.height * 0.125}L${cut.width * 0.125} ${cut.height * 0.875}`"
            />
          </g>
          <path
            class="current"
            :class="{ overlaps }"
            :d="label.cutPath"
            :transform="`translate(${position.x} ${position.y})`"
            @pointerdown="startDrag"
          />
          <g v-if="head" class="head" :transform="`translate(${head.x + crossOffset.x} ${head.y + crossOffset.y})`">
            <title>Red cross</title>
            <path d="M-6 0H6M0 -6V6" />
          </g>
        </svg>
        <button
          v-if="history.length"
          type="button"
          class="secondary clear-board"
          :class="`at-${clearBoardCorner}`"
          @click="history = []"
        >Clear board</button>
      </div>
      <div class="position-controls">
        <label><span>x =</span><input :value="position.x.toFixed(2)" type="number" min="0" :max="Math.max(0, bed.width - label.width)" step="0.01" @change="setPosition('x', $event)" /><span>mm,</span></label>
        <label><span>y =</span><input :value="position.y.toFixed(2)" type="number" min="0" :max="Math.max(0, bed.height - label.height)" step="0.01" @change="setPosition('y', $event)" /><span>mm</span></label>
      </div>
      <p v-if="!positionFitsBed" class="warning">
        This label does not fit within the usable bed area ({{ bed.width }} × {{ bed.height }} mm), so it cannot be sent or framed.
      </p>
      <p v-if="overlaps" class="warning">The label overlaps a label cut earlier. Move it to free wood.</p>
    </fieldset>

    <p v-if="serialMissing" class="warning">{{ serialMissing }} You can still download the SVG or the G-code.</p>
    <template v-else>
      <section class="machine-controls" aria-label="Laser cutter controls">
        <div class="machine-control-row connection-row">
          <span class="status">{{ s1 ? stateText : 'Not connected' }}</span>
          <button v-if="!s1" type="button" class="connect-button" @click="connect">
            Connect to xTool S1<br />laser cutter (USB)
          </button>
          <button v-else type="button" class="secondary" @click="s1.close()">Disconnect</button>
        </div>

        <div class="machine-control-row">
          <span class="control-label">Framing</span>
          <div class="actions corner-actions">
            <button
              v-for="corner in corners"
              :key="corner.name"
              type="button"
              class="secondary"
              :disabled="!canMoveCross"
              :title="`Red cross to the ${corner.name} corner`"
              @click="showCorner(corner)"
            >{{ corner.symbol }}</button>
            <button type="button" class="secondary frame-button" :disabled="!canFrame" @click="frameLabel">Frame label</button>
          </div>
        </div>

        <div class="machine-control-row send-row">
          <label v-if="!settingsChanged" class="choice send-hint" :class="{ inactive: !s1 }">
            <input v-model="plywoodConfirmed" type="checkbox" :disabled="!s1" />
            3 mm plywood
          </label>
          <p v-else class="warning settings-warning" aria-live="polite">
            Defaults have been overwritten. These settings may not be tuned for {{ material }}.
          </p>
          <button type="button" :disabled="!canSend" @click="send">Send job to laser cutter</button>
        </div>

        <div v-if="waitingForButton || error" class="machine-feedback" aria-live="polite">
          <p v-if="waitingForButton" class="warning">Job sent. <strong>Press the front button on the S1 to start it.</strong></p>
          <p v-else-if="error" class="warning">{{ error }}</p>
        </div>
      </section>
    </template>

    <details class="downloads">
      <summary>Download files</summary>
      <div class="actions">
        <button type="button" class="secondary" @click="downloadSvg">Download SVG</button>
        <button type="button" class="secondary" @click="downloadGcode">Download G-code</button>
      </div>
      <p class="download-guide">
        To use this design in xTool Studio / XCS, download the SVG and import it into your project. The layers use colors
        to distinguish operations: red is intended for cutting, black for engraving, and blue for the pattern.
        After importing, you can assign processing modes and choose settings for your material and machine. For example,
        a lighter setting such as low-power Score may suit the blue pattern. If engraving, patterning, and cutting are
        separate passes, consider running the first two before cutting.
      </p>
    </details>
  </form>
</template>
