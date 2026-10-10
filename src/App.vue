<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { fileName, layoutLabel, loadFonts, toSvg, type LabelOptions } from './label'

const options = reactive<LabelOptions>({
  text: 'Mehl\nWeizen 700',
  textSize: 6,
  holes: 'none',
  holeAlign: 'middle',
  holeDiameter: 3,
  frame: true,
})

// logarithmic slider: equal slider steps change the letter height by equal ratios
const minTextSize = 3
const maxTextSize = 50
const textSizeSlider = computed({
  get: () => Math.log(options.textSize / minTextSize) / Math.log(maxTextSize / minTextSize),
  set: (position: number) => {
    const size = minTextSize * (maxTextSize / minTextSize) ** position
    options.textSize = size < 10 ? Math.round(size * 10) / 10 : Math.round(size * 2) / 2
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

const holeModes = [
  { value: 'none', label: 'None' },
  { value: 'top', label: '1 · top' },
  { value: 'sides', label: '2 · sides' },
  { value: 'corners', label: '4 · corners' },
] as const

function svgFile() {
  return new File([toSvg(label.value!)], fileName(options.text), { type: 'image/svg+xml' })
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
    <h1>Commons Hub Labels</h1>

    <section class="preview">
      <svg
        v-if="label"
        :viewBox="`-1 -1 ${previewBox.width + 2} ${previewBox.height + 2}`"
        :style="{ maxWidth: `${previewBox.width * 6}px` }"
      >
        <g :transform="`translate(0 ${previewBox.labelY})`">
          <path class="wood" :d="label.cutPath" fill-rule="evenodd" />
          <path class="engraving" :d="label.framePath" fill-rule="evenodd" />
          <path class="engraving" :d="label.textPath" />
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

      <label>
        Letter height: {{ options.textSize }} mm
        <input v-model.number="textSizeSlider" type="range" min="0" max="1" step="0.001" />
      </label>

      <label class="choice">
        <input v-model="options.frame" type="checkbox" />
        Engraved frame
      </label>

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
        <input v-model.number="options.holeDiameter" type="range" min="1" max="5" step="0.5" />
      </label>

      <div class="actions">
        <button type="button" :disabled="!label" @click="download">Download SVG</button>
        <button v-if="canShare" type="button" :disabled="!label" @click="share">Share…</button>
      </div>
    </form>

    <aside>
      In xTool Studio / XCS: set the <strong class="cut">red layer</strong> to <em>Cut</em> and the
      <strong>black layer</strong> to <em>Engrave</em>, and process the black layer first.
    </aside>
  </main>
</template>
