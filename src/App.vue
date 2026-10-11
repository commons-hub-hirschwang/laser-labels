<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { fileName, layoutLabel, loadFonts, toSvg, type LabelOptions } from './label'
import { createPattern, type Pattern } from './pattern'
import LaserPanel from './LaserPanel.vue'

const defaults: LabelOptions = {
  text: 'Mehl\nWeizen 700',
  textSize: 10,
  padding: 1,
  holes: 'sides',
  holeAlign: 'middle',
  holeDiameter: 4,
  frame: false,
  innerLine: true,
  pattern: 'network',
  patternSeed: 1,
  qrPosition: 'none',
  qrContent: '',
  qrSize: 20,
}

const patternStyles = [
  { value: 'none', label: 'None' },
  { value: 'contours', label: 'Contours' },
  { value: 'flow', label: 'Flow' },
  { value: 'network', label: 'Network' },
] as const

// settings survive page reloads; storage may be unavailable (private mode, blocked site data)
const storageKey = 'label-options'
function storedOptions(): Partial<LabelOptions> {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
    // drop patterns that were renamed or removed since
    if (!patternStyles.some((style) => style.value === stored.pattern)) delete stored.pattern
    return stored
  } catch {
    return {}
  }
}

const options = reactive<LabelOptions>({ ...defaults, ...storedOptions() })
watch(options, () => {
  try {
    localStorage.setItem(storageKey, JSON.stringify(options))
  } catch {
    // not saved, the page still works
  }
})

/** everything back to the defaults, except the text */
function resetOptions() {
  Object.assign(options, { ...defaults, text: options.text })
}

function reshufflePattern() {
  options.patternSeed = Math.floor(Math.random() * 2 ** 31)
}

// logarithmic slider: equal slider steps change the letter height by equal ratios
const minTextSize = 3
const maxTextSize = 50
const textSizeSlider = computed({
  get: () => Math.log(options.textSize / minTextSize) / Math.log(maxTextSize / minTextSize),
  set: (position: number) => {
    const size = minTextSize * (maxTextSize / minTextSize) ** position
    options.textSize = Math.round(size)
  },
})

// 1 euro coin for scale: 23.25 mm, brass ring around a silver core
const coin = { diameter: 23.25, core: 16.25, gap: 6 }
const previewBox = computed(() => {
  const l = label.value!
  const width = l.width + coin.gap + coin.diameter
  const height = Math.max(l.height, coin.diameter)
  return { width, height, labelY: (height - l.height) / 2, coinX: l.width + coin.gap + coin.diameter / 2 }
})

const fontsLoaded = ref(false)
loadFonts().then(() => (fontsLoaded.value = true))

const label = computed(() => (fontsLoaded.value ? layoutLabel(options) : undefined))

// the pattern grows visibly; larger labels grow faster so the animation takes similarly long
let pattern: Pattern | undefined
let animationFrame = 0
const patternPath = ref('')
watch(label, (current) => {
  cancelAnimationFrame(animationFrame)
  patternPath.value = ''
  pattern = current?.pattern && createPattern(current.pattern)
  if (!pattern) return
  const growing = pattern
  const stepsPerFrame = Math.max(50, (current!.width * current!.height) / 60)
  const animate = () => {
    const done = growing.advance(stepsPerFrame)
    patternPath.value = growing.path()
    if (!done) animationFrame = requestAnimationFrame(animate)
  }
  animate()
}, { immediate: true })

const qrPositions = [
  { value: 'none', label: 'None' },
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
  { value: 'top', label: 'Above' },
  { value: 'bottom', label: 'Below' },
] as const

const hasText = computed(() => options.text.trim() !== '')
const qrOnly = computed(() => !hasText.value && !!label.value?.qr)
/** below this, phone cameras start to struggle with engraved wood */
const minModuleSize = 0.5

const holeModes = [
  { value: 'none', label: 'None' },
  { value: 'top', label: '1 · top' },
  { value: 'sides', label: '2 · sides' },
  { value: 'corners', label: '4 · corners' },
] as const

/** finishes growing right away instead of waiting for the animation */
function finishPattern() {
  if (pattern) {
    cancelAnimationFrame(animationFrame)
    pattern.advance(Infinity)
    patternPath.value = pattern.path()
  }
  return patternPath.value
}

function svgFile() {
  return new File([toSvg(label.value!, finishPattern())], fileName(options.text), { type: 'image/svg+xml' })
}

function download() {
  const file = svgFile()
  const link = document.createElement('a')
  link.href = URL.createObjectURL(file)
  link.download = file.name
  link.click()
  URL.revokeObjectURL(link.href)
}

const canShare = typeof navigator.canShare === 'function' &&
  navigator.canShare({ files: [new File([''], 'test.svg', { type: 'image/svg+xml' })] })

async function share() {
  try {
    await navigator.share({ files: [svgFile()] })
  } catch (error) {
    if ((error as Error).name !== 'AbortError') throw error
  }
}
</script>

<template>
  <main>
    <header>
      <h1>Commons Hub Labels</h1>
      <button type="button" class="secondary" @click="resetOptions">Reset to defaults</button>
    </header>

    <section class="preview">
      <svg
        v-if="label"
        :viewBox="`-1 -1 ${previewBox.width + 2} ${previewBox.height + 2}`"
        :style="{ maxWidth: `${previewBox.width * 6}px` }"
      >
        <g :transform="`translate(0 ${previewBox.labelY})`">
          <path class="wood" :d="label.cutPath" fill-rule="evenodd" />
          <path class="pattern" :d="patternPath" />
          <path class="engraving" :d="label.framePath" fill-rule="evenodd" />
          <path class="engraving" :d="label.textPath" />
          <path class="engraving" :d="label.qrPath" />
          <!-- holes are cut through everything, so they go on top -->
          <circle v-for="(hole, index) in label.holes" :key="index" class="hole" :cx="hole.x" :cy="hole.y" :r="hole.r" />
        </g>
        <g class="coin" :transform="`translate(${previewBox.coinX} ${previewBox.height / 2})`">
          <title>1 € coin for scale</title>
          <circle class="ring" :r="coin.diameter / 2" />
          <circle class="core" :r="coin.core / 2" />
          <text dy="0.35em">1 €</text>
        </g>
      </svg>
      <p v-if="label" class="dimensions">{{ label.width.toFixed(1) }} × {{ label.height.toFixed(1) }} mm</p>
    </section>

    <form @submit.prevent>
      <label>
        Text
        <textarea v-model="options.text" rows="3" />
      </label>

      <label v-if="!qrOnly">
        Letter height: {{ options.textSize }} mm
        <input v-model.number="textSizeSlider" type="range" min="0" max="1" step="0.001" />
      </label>

      <label>
        Padding: {{ options.padding.toFixed(1) }} × {{ qrOnly ? '⅕ QR size' : 'letter height' }}
        <input v-model.number="options.padding" type="range" min="0.2" max="3" step="0.1" />
      </label>

      <label class="choice">
        <input v-model="options.frame" type="checkbox" />
        Engraved frame
      </label>

      <label v-if="options.frame" class="choice">
        <input v-model="options.innerLine" type="checkbox" />
        Thin inner line
      </label>

      <fieldset>
        <legend>Background pattern</legend>
        <div class="choices">
          <label v-for="style in patternStyles" :key="style.value" class="choice">
            <input v-model="options.pattern" type="radio" :value="style.value" />
            {{ style.label }}
          </label>
          <button v-if="options.pattern !== 'none'" type="button" class="secondary" @click="reshufflePattern">
            Regenerate
          </button>
        </div>
      </fieldset>

      <fieldset>
        <legend>QR code</legend>
        <div class="choices">
          <label v-for="position in qrPositions" :key="position.value" class="choice">
            <input v-model="options.qrPosition" type="radio" :value="position.value" />
            {{ position.label }}
          </label>
        </div>
      </fieldset>

      <template v-if="options.qrPosition !== 'none'">
        <label>
          QR content
          <input v-model="options.qrContent" type="url" placeholder="https://…" />
        </label>
        <p v-if="!hasText" class="muted">No text: the label holds only the QR code.</p>

        <label>
          QR size: {{ options.qrSize }} mm
          <input v-model.number="options.qrSize" type="range" min="10" max="60" step="1" />
        </label>
        <p v-if="label?.qrError" class="warning">{{ label.qrError }}</p>
        <p v-else-if="label?.qr && label.qr.moduleSize < minModuleSize" class="warning">
          The QR dots are only {{ label.qr.moduleSize.toFixed(2) }} mm; phones may not read them on wood. Make the QR
          code bigger or the content shorter.
        </p>
      </template>

      <fieldset>
        <legend>Holes</legend>
        <label v-for="mode in holeModes" :key="mode.value" class="choice">
          <input v-model="options.holes" type="radio" :value="mode.value" />
          {{ mode.label }}
        </label>
      </fieldset>

      <fieldset v-if="options.holes === 'sides'">
        <legend>Hole position</legend>
        <label class="choice"><input v-model="options.holeAlign" type="radio" value="top" /> Top</label>
        <label class="choice"><input v-model="options.holeAlign" type="radio" value="middle" /> Middle</label>
      </fieldset>

      <label v-if="options.holes !== 'none'">
        Hole diameter: {{ options.holeDiameter }} mm
        <input v-model.number="options.holeDiameter" type="range" min="2" max="10" step="0.5" />
      </label>

      <div class="actions">
        <button type="button" :disabled="!label" @click="download">Download SVG</button>
        <button v-if="canShare" type="button" :disabled="!label" @click="share">Share…</button>
      </div>
    </form>

    <LaserPanel v-if="label" :label="label" :text="options.text" :finish-pattern="finishPattern" />

    <aside>
      Without the S1 on USB, or for other materials, download the SVG. In xTool Studio / XCS: set the <strong class="cut">red layer</strong> to <em>Cut</em> and the
      <strong>black layer</strong> to <em>Engrave</em>. The <strong class="score">blue layer</strong> is the
      pattern: give it a lighter setting, e.g. <em>Score</em> with low power. Process engraving and pattern before
      cutting.
    </aside>
  </main>
</template>
