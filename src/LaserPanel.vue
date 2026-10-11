<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { generateJob } from './gcode'
import type { Label } from './label'
import { bed, deviceStates, focusZ, material, plywoodSettings, type LaserSettings } from './machine'
import type { Point } from './pathGeometry'
import { S1, serialSupported } from './s1'

const props = defineProps<{
  label: Label
  text: string
  /** finishes the pattern and returns its path data */
  finishPattern: () => string
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

// label position on the bed (top-left corner), kept inside the bed
const position = reactive<Point>(load('laser-position', { x: 3.7, y: 229 }))
watch(position, () => save('laser-position', position))
function clampPosition() {
  position.x = Math.round(Math.min(Math.max(position.x, 0), bed.width - props.label.width) * 10) / 10
  position.y = Math.round(Math.min(Math.max(position.y, 0), bed.height - props.label.height) * 10) / 10
}
watch(() => [props.label.width, props.label.height], clampPosition, { immediate: true })

interface CutLabel { text: string; cutPath: string; x: number; y: number; width: number; height: number; date: string }
const history = ref<CutLabel[]>(load<{ labels: CutLabel[] }>('laser-history', { labels: [] }).labels)
watch(history, () => save('laser-history', { labels: history.value }), { deep: true })

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
  position.x = dragStart.position.x + point.x - dragStart.pointer.x
  position.y = dragStart.position.y + point.y - dragStart.pointer.y
  clampPosition()
}
const endDrag = () => (dragStart = undefined)

// machine
const s1 = ref<S1>()
const state = ref<number>()
const head = ref<Point>()
const crossOffset = ref<Point>({ x: 0, y: 0 })
const progress = ref<number>()
const error = ref('')
const plywoodConfirmed = ref(false)
/** the label being cut, added to the history when the S1 reports done */
let running: CutLabel | undefined

const stateText = computed(() => {
  if (progress.value !== undefined) return `Uploading… ${Math.round(progress.value * 100)} %`
  if (state.value === undefined) return 'Connected'
  return deviceStates[state.value] ?? `State ${state.value}`
})

async function connect() {
  error.value = ''
  try {
    const machine = await S1.connect()
    machine.onState = (value) => {
      state.value = value
      if (value === 19 && running) {
        history.value.push(running)
        running = undefined
      }
    }
    machine.onPosition = (value) => (head.value = value)
    machine.onClose = () => {
      s1.value = undefined
      state.value = undefined
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

function job() {
  return generateJob({
    textPath: props.label.textPath,
    framePath: props.label.framePath,
    patternPath: props.finishPattern(),
    cutPath: props.label.cutPath,
    position,
    settings,
    head: head.value ?? { x: 29.6, y: 216.78 },
  })
}

const canSend = computed(() => s1.value && plywoodConfirmed.value && state.value === 3 && progress.value === undefined)

async function send() {
  error.value = ''
  progress.value = 0
  try {
    const { width, height, cutPath } = props.label
    await s1.value!.sendJob(job(), (fraction) => (progress.value = fraction))
    running = { text: props.text.trim().split('\n')[0]!, cutPath, x: position.x, y: position.y, width, height, date: new Date().toISOString() }
    plywoodConfirmed.value = false // asked again for every label
  } catch (reason) {
    error.value = (reason as Error).message
  } finally {
    progress.value = undefined
  }
}

function downloadGcode() {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([job()], { type: 'text/plain' }))
  link.download = 'tmp.gcode'
  link.click()
  URL.revokeObjectURL(link.href)
}
</script>

<template>
  <form class="laser" @submit.prevent>
    <h2>xTool S1</h2>

    <p class="warning">
      These settings are for <strong>{{ material }}</strong> only: the focus height (Z {{ focusZ }}) was measured on it,
      and power and speed are tuned for it. For any other material, use xTool Studio.
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
    <div class="actions">
      <button type="button" class="secondary" @click="resetSettings">Reset to {{ material }} settings</button>
    </div>

    <fieldset>
      <legend>Position on the bed</legend>
      <svg
        ref="bedMap"
        class="bed"
        :viewBox="`-2 -2 ${bed.width + 4} ${bed.height + 4}`"
        @pointermove="drag"
        @pointerup="endDrag"
        @pointercancel="endDrag"
      >
        <rect class="area" :width="bed.width" :height="bed.height" />
        <path
          v-for="(cut, index) in history"
          :key="index"
          class="cut-before"
          :d="cut.cutPath"
          :transform="`translate(${cut.x} ${cut.y})`"
        >
          <title>{{ cut.text }}, {{ new Date(cut.date).toLocaleDateString() }}</title>
        </path>
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
      <div class="choices">
        <label class="choice">X <input v-model.number="position.x" type="number" step="1" @change="clampPosition" /> mm</label>
        <label class="choice">Y <input v-model.number="position.y" type="number" step="1" @change="clampPosition" /> mm</label>
      </div>
      <p v-if="overlaps" class="warning">The label overlaps a label cut earlier. Move it to free wood.</p>
      <div v-if="history.length" class="choices">
        <span class="muted">{{ history.length }} label{{ history.length === 1 ? '' : 's' }} cut on this wood</span>
        <button type="button" class="secondary" @click="history.pop()">Remove last</button>
        <button type="button" class="secondary" @click="history = []">New wood</button>
      </div>
    </fieldset>

    <p v-if="!serialSupported" class="muted">Sending to the S1 needs Chrome or Edge (Web Serial).</p>
    <template v-else>
      <div class="actions">
        <button v-if="!s1" type="button" @click="connect">Connect S1 (USB)</button>
        <template v-else>
          <span class="status">{{ stateText }}</span>
          <button type="button" class="secondary" @click="s1.close()">Disconnect</button>
        </template>
      </div>

      <div v-if="s1" class="actions">
        Point the red cross at
        <button
          v-for="corner in corners"
          :key="corner.name"
          type="button"
          class="secondary"
          :title="`Red cross to the ${corner.name} corner`"
          @click="showCorner(corner)"
        >{{ corner.symbol }}</button>
      </div>

      <label v-if="s1" class="choice">
        <input v-model="plywoodConfirmed" type="checkbox" />
        {{ material }} is in the S1, at the position shown
      </label>
    </template>

    <p v-if="error" class="warning">{{ error }}</p>

    <div class="actions">
      <button v-if="serialSupported" type="button" :disabled="!canSend" @click="send">Send to S1</button>
      <button type="button" class="secondary" @click="downloadGcode">Download G-code</button>
    </div>
  </form>
</template>
