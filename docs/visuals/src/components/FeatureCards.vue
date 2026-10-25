<script setup lang="ts">
const installs = Array.from({ length: 10 }, (_, i) => i)
</script>

<template>
  <section class="how" aria-labelledby="what">
    <h2 id="what">
      What you get
    </h2>
    <div class="cards">
      <article class="card" tabindex="0">
        <div class="figure bundle-figure" aria-hidden="true">
          <div class="box">
            <div class="disc out" />
            <div class="disc in" />
            <div class="plate">
              Launcher
            </div>
          </div>
        </div>
        <h3>Only the bundle moves.</h3>
        <p>Main code, preload, and pages update in a few megabytes. The launcher under them changes only with a full install.</p>
      </article>

      <article class="card" tabindex="0">
        <div class="figure rollout-figure" aria-hidden="true">
          <div class="row">
            <span v-for="i in installs" :key="i" class="install" :class="{ first: i < 2 }" :style="{ '--i': i }" />
          </div>
          <p class="mono share">
            <span class="before">20%</span><span class="after">100%</span>
          </p>
        </div>
        <h3>A few installs go first.</h3>
        <p>Send a release to 20% of installs, then raise it. Installs that had it keep it.</p>
      </article>

      <article class="card" tabindex="0">
        <div class="figure files-figure" aria-hidden="true">
          <div class="sheet" style="--n: 0">
            Files
          </div>
          <div class="sheet" style="--n: 1">
            Manifests
          </div>
          <div class="sheet channel" style="--n: 2">
            Channel
          </div>
        </div>
        <h3>No update server.</h3>
        <p>CI signs static files and puts them in any bucket. The app reads them and checks every signature.</p>
      </article>
    </div>
  </section>
</template>

<style scoped>
.how {
  max-width: 1160px;
  margin: 0 auto;
  padding: 120px 24px 40px;
}

h2 {
  margin: 0 0 32px;
  font-size: clamp(30px, 4vw, 40px);
  font-weight: 600;
  letter-spacing: -0.02em;
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr));
  gap: 16px;
}

.card {
  padding: 16px 16px 28px;
  border-radius: 28px;
  background: var(--surface);
  outline-offset: 4px;
}

.card h3 {
  margin: 24px 12px 8px;
  font-size: 22px;
  font-weight: 600;
}

.card p {
  margin: 0 12px;
  color: var(--muted);
  font-size: 16px;
  line-height: 1.5;
  text-wrap: pretty;
}

.figure {
  position: relative;
  display: grid;
  overflow: hidden;
  height: 220px;
  border-radius: 20px;
  background: var(--figure-lo);
  place-items: center;
}

/* Only the bundle moves: hover lifts the old disc out and drops a new one in. */
.box {
  position: relative;
  width: 132px;
  height: 132px;
  border-radius: 32px;
  background: var(--device);
}

.disc {
  position: absolute;
  top: 22px;
  left: 40px;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  transition: transform 0.6s cubic-bezier(0.2, 0.7, 0.2, 1), opacity 0.6s;
}

.disc.out {
  background: var(--text);
}

.disc.in {
  background: var(--cyan);
  box-shadow: 0 0 21px rgb(var(--cyan-rgb) / 14%);
  opacity: 0;
  transform: translateY(-120px);
}

.plate {
  position: absolute;
  right: 12px;
  bottom: 12px;
  left: 12px;
  padding: 6px 0;
  border-radius: 12px;
  background: var(--well-lo);
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}

.card:hover .disc.out,
.card:focus-visible .disc.out {
  opacity: 0;
  transform: translate(90px, -40px) scale(0.6);
}

.card:hover .disc.in,
.card:focus-visible .disc.in {
  opacity: 1;
  transform: none;
  transition-delay: 0.15s;
}

/* A few installs go first: hover raises the rollout to everyone, one install after another. */
.row {
  display: grid;
  grid-template-columns: repeat(5, 28px);
  gap: 10px;
}

.install {
  width: 28px;
  height: 28px;
  border-radius: 9px;
  background: var(--surface-3);
  transition: background 0.3s, box-shadow 0.3s;
  transition-delay: calc(var(--i) * 60ms);
}

.install.first,
.card:hover .install,
.card:focus-visible .install {
  background: var(--cyan);
  box-shadow: 0 0 11px rgb(var(--cyan-rgb) / 12%);
}

.share {
  position: absolute;
  bottom: 18px;
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

.share span {
  transition: opacity 0.3s;
}

.share .after {
  position: absolute;
  left: 0;
  opacity: 0;
}

.card:hover .share .before,
.card:focus-visible .share .before {
  opacity: 0;
}

.card:hover .share .after,
.card:focus-visible .share .after {
  opacity: 1;
  transition-delay: 0.5s;
}

/* No update server: a stack of static files that fans out on hover. */
.sheet {
  position: absolute;
  display: grid;
  width: 96px;
  height: 80px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--device);
  box-shadow: 0 12px 24px var(--shadow);
  color: var(--muted);
  font-size: 14px;
  transform: translate(calc(var(--n) * 8px), calc(var(--n) * -8px));
  transition: transform 0.6s cubic-bezier(0.2, 0.7, 0.2, 1);
  align-content: end;
}

.sheet.channel {
  background: var(--channel-lo);
  color: var(--cyan-ink);
}

.card:hover .sheet,
.card:focus-visible .sheet {
  transform: translate(calc((var(--n) - 1) * 104px), 0) rotate(calc((var(--n) - 1) * 4deg));
}
</style>
