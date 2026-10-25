<script setup lang="ts">
import DownArrow from './DownArrow.vue'
</script>

<!--
  Connect the updater to your pages: one small widget follows updater.status. The left column shows it in each
  state, and the window shows where it lives: a corner with the progress and the button, and a rollback notice.
-->
<template>
  <div class="f-figure" role="img" aria-label="An update widget follows updater.status through updater.onStatus. While downloading, it shows the progress. When ready, it offers Restart to update, which calls updater.applyUpdate. While applying, it shows Restarting. After a rollback, a notice offers Dismiss, which calls updater.dismissRollback.">
    <svg class="f-wires" width="1440" height="480" aria-hidden="true">
      <path d="M390 200 C430 200 430 250 470 250" />
      <path d="M668 250 H860" />
      <path d="M720 136 H860" />
      <path d="M686 380 H860" />
    </svg>

    <div class="states" style="left: 90px; top: 34px">
      <p class="f-label">
        downloading
      </p>
      <div class="widget">
        <span class="text">Downloading 1.0.4</span>
        <span class="progress"><i style="width: 62%" /></span>
        <span class="f-label">62%</span>
      </div>
      <DownArrow class="short" />
      <p class="f-label">
        ready
      </p>
      <div class="widget">
        <span class="text">1.0.4 is ready</span>
        <span class="button small">Restart to update</span>
      </div>
      <DownArrow class="short" />
      <p class="f-label">
        applying
      </p>
      <div class="widget">
        <i class="f-lamp" />
        <span class="text">Restarting…</span>
      </div>
      <p class="f-label failed-label">
        rolled-back <span class="why">when a bundle fails</span>
      </p>
      <div class="widget">
        <i class="dot" />
        <span class="text">1.0.5 failed. Back on 1.0.4.</span>
        <span class="link">Dismiss</span>
      </div>
    </div>

    <span class="f-chip call" style="left: 470px; top: 228px">updater.onStatus(…)</span>
    <span class="f-chip call" style="left: 470px; top: 114px">updater.dismissRollback()</span>
    <span class="f-chip call" style="left: 470px; top: 360px">updater.applyUpdate()</span>

    <div class="f-device window" style="left: 860px; top: 40px">
      <span class="dots"><i /><i /><i /></span>

      <div class="notice">
        <i class="dot" />
        <span class="text">1.0.5 did not start. You are back on 1.0.4.</span>
        <span class="link">Dismiss</span>
      </div>

      <span class="bar" style="top: 196px; width: 64%" />
      <span class="bar" style="top: 224px; width: 48%" />
      <span class="bar" style="top: 252px; width: 56%" />

      <!-- The widget lives in a corner: the version, the progress, and the button. -->
      <div class="corner">
        <span class="version">
          <span class="text">1.0.4</span>
          <span class="progress"><i style="width: 100%" /></span>
        </span>
        <span class="button">Restart to update</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.states {
  display: flex;
  width: 300px;
  flex-direction: column;
  gap: 4px;
}

.states .f-label {
  margin: 0 0 2px 4px;
}

.failed-label {
  margin-top: 18px !important;
}

.why {
  margin-left: 6px;
  color: var(--soft);
  font-family: var(--font-sans);
  font-size: 14px;
}

.short {
  height: 18px;
  margin: 2px 0 2px 24px;
}

.widget {
  display: flex;
  height: 48px;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  border-radius: 14px;
  background: var(--device);
  box-shadow: 0 6px 16px var(--shadow);
}

.text {
  color: var(--soft);
  font-size: 14px;
  white-space: nowrap;
}

.widget .text {
  flex: 1;
}

.progress {
  position: relative;
  overflow: hidden;
  width: 70px;
  height: 6px;
  flex: none;
  border-radius: 3px;
  background: var(--surface-2);
}

.progress i {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 3px;
  background: var(--cyan);
}

.dot {
  width: 10px;
  height: 10px;
  flex: none;
  border-radius: 50%;
  background: var(--red);
}

.link {
  color: var(--muted);
  font-size: 13px;
}

.button {
  padding: 9px 14px;
  border-radius: 999px;
  background: var(--text);
  color: var(--bg);
  font-size: 14px;
  white-space: nowrap;
}

.button.small {
  padding: 6px 11px;
  font-size: 12px;
}

.call {
  font-size: 15px;
}

.window {
  width: 500px;
  height: 400px;
  border-radius: 22px;
}

.window > * {
  position: absolute;
}

.dots {
  top: 18px;
  left: 22px;
  display: flex;
  gap: 6px;
}

.dots i {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--surface-3);
}

.notice {
  top: 66px;
  right: 22px;
  left: 22px;
  display: flex;
  height: 60px;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  border-radius: 16px;
  background: var(--surface);
}

.notice .text {
  flex: 1;
}

.bar {
  left: 22px;
  height: 12px;
  border-radius: 6px;
  background: var(--surface-2);
}

.corner {
  bottom: 22px;
  left: 22px;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 12px 12px 16px;
  border-radius: 18px;
  background: var(--surface);
}

.version {
  display: grid;
  gap: 6px;
}
</style>
