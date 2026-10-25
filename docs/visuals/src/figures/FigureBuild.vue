<script setup lang="ts">
const sources = [
  { file: 'src/main/index.ts', plugin: 'ergosphereMain()' },
  { file: 'src/preload/index.ts', plugin: 'ergospherePreload()' },
  { file: 'src/renderer/index.html', plugin: 'ergosphereRenderer()' },
]
</script>

<!-- Add the build plugins: one plugin per process, one build, and two parts out: the launcher and the bundle. -->
<template>
  <div class="f-figure" role="img" aria-label="A plugin goes into each process of the electron-vite build: main, preload, and renderer. The build writes two parts: a launcher that ships in the installer, and a bundle that updates over the air.">
    <svg class="f-wires" width="1440" height="480" aria-hidden="true">
      <path d="M390 114 C455 114 455 240 520 240" />
      <path d="M390 240 H520" />
      <path d="M390 366 C455 366 455 240 520 240" />
      <path d="M760 240 C820 240 820 130 880 130" />
      <path d="M760 240 C820 240 820 350 880 350" />
    </svg>

    <div
      v-for="(s, i) in sources"
      :key="s.file"
      class="f-device source"
      :style="{ left: '90px', top: `${72 + i * 126}px` }"
    >
      <span class="f-label">{{ s.file }}</span>
      <span class="plugin">{{ s.plugin }}</span>
    </div>

    <div class="f-device vite" style="left: 520px; top: 170px">
      <span class="lamps"><i class="f-lamp" /><i class="f-lamp" /><i class="f-lamp" /></span>
      <span>electron-vite build</span>
    </div>

    <div class="f-device" style="left: 880px; top: 80px; width: 170px; height: 100px">
      <span class="f-plate">Launcher</span>
    </div>
    <div style="left: 1076px; top: 88px; width: 300px">
      <p class="f-title">
        out/launcher
      </p>
      <p class="f-note">
        Ships in the installer. Changes only with a full install.
      </p>
    </div>

    <div class="f-device bundle" style="left: 880px; top: 280px">
      <div class="f-disc new" style="width: 72px; height: 72px">
        Bundle
      </div>
    </div>
    <div style="left: 1076px; top: 284px; width: 310px">
      <p class="f-title">
        out/bundle
      </p>
      <p class="f-note">
        Main, preload, and pages, with bundle.json: every file and its hash. Updates over the air.
      </p>
    </div>
  </div>
</template>

<style scoped>
.source {
  display: grid;
  width: 300px;
  height: 84px;
  padding: 16px 20px;
  border-radius: 22px;
  align-content: center;
  gap: 6px;
}

.plugin {
  font-family: var(--font-mono);
  font-size: 15px;
}

.vite {
  display: grid;
  width: 240px;
  height: 140px;
  font-family: var(--font-mono);
  font-size: 15px;
  gap: 14px;
  place-content: center;
  justify-items: center;
}

.lamps {
  display: flex;
  gap: 8px;
}

.bundle {
  display: grid;
  width: 170px;
  height: 140px;
  place-items: center;
}
</style>
