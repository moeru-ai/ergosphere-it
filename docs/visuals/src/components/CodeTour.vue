<script setup lang="ts">
import highlighted from 'virtual:highlighted-samples'
import { computed, ref } from 'vue'

import { SAMPLES } from '../code/samples'
import { theme } from '../theme'

const selected = ref(0)
/** The note under the pointer. With none, every line shows at full strength. */
const active = ref<number>()

const sample = computed(() => SAMPLES[selected.value]!)
const lines = computed(() => highlighted[theme.value][selected.value] ?? [])

/** The note that each line belongs to, by line number. */
const noteOfLine = computed(() => {
  const map = new Map<number, number>()
  sample.value.notes.forEach((note, i) => note.lines.forEach(line => map.set(line, i)))
  return map
})

function select(index: number): void {
  selected.value = index
  active.value = undefined
}

function hoverLine(line: number): void {
  const note = noteOfLine.value.get(line)
  if (note !== undefined)
    active.value = note
}

function lineState(line: number): 'dim' | 'lit' | undefined {
  if (active.value === undefined)
    return undefined
  return sample.value.notes[active.value]?.lines.includes(line) ? 'lit' : 'dim'
}

function tokenStyle(token: { color?: string, fontStyle?: number }): Record<string, string> {
  const style: Record<string, string> = {}
  if (token.color)
    style.color = token.color
  if ((token.fontStyle ?? 0) & 1)
    style.fontStyle = 'italic'
  if ((token.fontStyle ?? 0) & 2)
    style.fontWeight = '600'
  return style
}
</script>

<template>
  <section class="section" aria-labelledby="setup">
    <h2 id="setup">
      Set it up
    </h2>

    <div class="keys" role="tablist" aria-label="Files">
      <button
        v-for="(s, i) in SAMPLES"
        :key="s.key"
        type="button"
        role="tab"
        class="key"
        :class="{ on: selected === i }"
        :aria-selected="selected === i"
        @click="select(i)"
      >
        <span class="dot" />
        <span class="mono num">{{ i + 1 }}</span>
        <span class="mono name">{{ s.key }}</span>
      </button>
    </div>

    <div class="tour" @mouseleave="active = undefined">
      <figure class="code">
        <figcaption class="mono file">
          {{ sample.file }}
        </figcaption>
        <!-- Lines are blocks, so the pre holds no whitespace of its own. -->
        <pre class="mono"><code><span v-for="(line, i) in lines" :key="`${selected}-${i}`" class="line" :class="[lineState(i + 1), { noted: noteOfLine.has(i + 1) }]" @mouseenter="hoverLine(i + 1)"><span class="ln">{{ i + 1 }}</span><span v-for="(token, j) in line" :key="j" :style="tokenStyle(token)">{{ token.content }}</span><br v-if="line.length === 0"></span></code></pre>
      </figure>

      <ol class="notes">
        <li v-for="(note, i) in sample.notes" :key="`${selected}-${i}`">
          <button
            type="button"
            class="note"
            :class="{ on: active === i }"
            @mouseenter="active = i"
            @focus="active = i"
            @blur="active = undefined"
            @click="active = i"
          >
            <span class="mono where">{{ note.lines.map(l => `L${l}`).join(' ') }}</span>
            <span>{{ note.text }}</span>
          </button>
        </li>
      </ol>
    </div>
  </section>
</template>

<style scoped>
.section {
  max-width: 1160px;
  margin: 0 auto;
  padding: 120px 24px 0;
}

h2 {
  margin: 0 0 24px;
  font-size: clamp(30px, 4vw, 40px);
  font-weight: 600;
  letter-spacing: -0.02em;
}

/* The same numbered keys as the machine above. */
.keys {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 16px;
}

.key {
  display: grid;
  min-width: 84px;
  padding: 10px 12px;
  border: 0;
  border-radius: 14px;
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 4px 8px;
  text-align: left;
  transition: background 0.2s;
}

.key:hover {
  background: var(--surface-2);
}

.key .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--surface-3);
  transition: background 0.3s;
}

.key .num {
  color: var(--faint);
  font-size: 11px;
}

.key .name {
  grid-column: 1 / -1;
  font-size: 13px;
}

.key.on {
  background: var(--surface-3);
  color: var(--text);
}

.key.on .dot {
  background: var(--orange);
  box-shadow: 0 0 7px rgb(var(--orange-rgb) / 28%);
}

.tour {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 16px;
}

.code {
  flex: 999 1 560px;
  min-width: 0;
  margin: 0;
  padding: 8px;
  border-radius: 28px;
  background: var(--surface);
}

.file {
  padding: 10px 16px 12px;
  color: var(--faint);
  font-size: 12px;
}

pre {
  overflow-x: auto;
  margin: 0;
  padding: 18px 0;
  border-radius: 22px;
  background: var(--code-bg);
  font-size: 14px;
  line-height: 1.75;
}

code {
  display: block;
  min-width: max-content;
  font-family: inherit;
}

.line {
  display: block;
  padding: 0 24px 0 0;
  transition: opacity 0.25s, background 0.25s, box-shadow 0.25s;
}

.line.noted {
  box-shadow: inset 2px 0 0 rgb(var(--orange-rgb) / 35%);
  cursor: default;
}

/* A focused note lights its lines and dims the rest. */
.line.dim {
  opacity: 0.38;
}

.line.lit {
  background: var(--hover-line);
  box-shadow: inset 2px 0 0 var(--orange);
}

.ln {
  display: inline-block;
  width: 3.5em;
  padding-right: 1.4em;
  color: var(--line-number);
  text-align: right;
  user-select: none;
}

.notes {
  display: flex;
  flex: 1 1 300px;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.note {
  display: grid;
  width: 100%;
  padding: 14px 18px;
  border: 0;
  border-radius: 18px;
  background: var(--surface);
  color: var(--muted);
  cursor: default;
  font: inherit;
  font-size: 15px;
  gap: 4px;
  line-height: 1.5;
  text-align: left;
  transition: background 0.25s, color 0.25s;
}

.note .where {
  color: var(--faint);
  font-size: 12px;
  transition: color 0.25s;
}

.note.on {
  background: var(--surface-2);
  color: var(--text);
}

.note.on .where {
  color: var(--orange);
}
</style>
