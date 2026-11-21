<script setup>
import { computed, ref, watch } from 'vue';
import { useLiveUpdate } from '@disguise-one/vue-liveupdate';

// Access stored IP address, fallback to build-time env
const storedIP = localStorage.getItem('directorEndpoint')
const defaultEndpoint = `${import.meta.env.VITE_DIRECTOR_HOST || 'localhost'}:${import.meta.env.VITE_DIRECTOR_PORT || '80'}`
const endpointInput = ref(storedIP || defaultEndpoint)

// Save IP address when changed
watch(endpointInput, (newIP) => {
  localStorage.setItem('directorEndpoint', newIP)
})

// Direct connection to Director via @disguise-one/vue-liveupdate
const liveUpdate = useLiveUpdate(endpointInput.value)


// Reconnect logic with new endpoint
function localReconnect() {
  localStorage.setItem('directorEndpoint', endpointInput.value)
  window.location.reload()
}

watch(endpointInput, (newVal) => {
  // if (import.meta.env.DEV) console.log('Updated endpointInput:', newVal)
})

// if (import.meta.env.DEV) console.log('Target IP:', endpointInput.value);

// --- Debug panel (dev only) ---
const debugOpen = ref(false)
const isDev = import.meta.env.DEV
const debugInfo = computed(() => liveUpdate.debugInfo?.value ?? {})
const allValues = computed(() => {
  if (!debugInfo.value?.values) return {}
  return debugInfo.value.values
})
const allSubscriptions = computed(() => {
  if (!debugInfo.value?.subscriptions?.value) return []
  return debugInfo.value.subscriptions.value
})

if (import.meta.env.DEV) {
  window.__liveUpdate = liveUpdate
  // console.log('[D3Reporter] liveUpdate instance exposed as window.__liveUpdate')
}

//Connection status display and classing
const connectionStatus = computed(() => {
  return liveUpdate.status?.value ?? 'unknown'
})

const connectionStatusClass = computed(() => {
  switch (connectionStatus.value) {
    case 'OPEN': return 'status-connected'
    case 'CONNECTING': return 'status-connecting'
    case 'CLOSED': return 'status-disconnected'
    case 'unknown': return 'status-disconnected'
    default: return ''
  }
})
</script>

<template>
  <div class="app">
    <header>
      <h1>Disguise Reporter</h1>
      <span :class="[connectionStatusClass, 'status-text']" v-if="connectionStatus === 'OPEN'">CONNECTED</span>
      <nav class="nav-links">
        <router-link to="/track-detail">Track Details</router-link> |
        <router-link to="/timeline">Timeline</router-link> |
        <router-link to="/metrics">Metrics</router-link>
      </nav>
    </header>
    <div v-if="connectionStatus !== 'OPEN'" class="modal-overlay">
      <div class="modal-content">
        <h2>Disconnected</h2>
        <p>Enter IP:port of Disguise Server:</p>
        <input v-model="endpointInput" placeholder="192.168.1.201:80" />
        <button class="button-connect" @click="localReconnect">Reconnect</button>
      </div>
    </div>
    <!-- Routed content view -->
    <main>
      <router-view v-slot="{ Component }">
        <component :is="Component" :liveUpdate="liveUpdate" />
      </router-view>
      <!-- Overlay component for lost connection -->
      <!--<LiveUpdateOverlay class="overlay-ui" :liveUpdate="liveUpdate" />-->
    </main>
    <footer>
      <a href="https://www.disguise.one/en" target="_blank">
        <img src="./assets/logo.svg" class="logo" alt="Disguise logo" />
      </a>
      <!-- Debug panel (dev only) -->
      <details v-if="isDev" class="debug-panel" :open="debugOpen">
        <summary style="cursor:pointer;font-weight:bold;font-size:0.8rem;">Debug</summary>
        <div class="debug-content">
          <div>Status: <strong>{{ connectionStatus }}</strong></div>
           <div>Subscriptions: {{ allSubscriptions.length }}</div>
          <pre>{{ JSON.stringify(allValues, null, 2) }}</pre>
        </div>
      </details>
    </footer>
  </div>
</template>

<style scoped>
.logo {
  width: 8em;
  padding: 1.5em;
  will-change: filter;
  transition: filter 300ms;
}
.logo:hover {
  filter: drop-shadow(0 0 2em #888888dd);
}
header {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 2rem;
}
.nav-links {
  margin-top: 0.5rem;
  box-shadow: 0px 1px 0px 0px #c0c0c0;
		background:linear-gradient(to bottom, #b0b0b0 5%, #6b6b6b 100%);
		background-color:#b0b0b0;
		border-radius:15px;
		border:2px solid #555555;
		display:inline-block;
		color:#ffffff;
		font-family:Arial;
		font-size:16px;
		font-weight:bold;
		padding:12px 16px;
		text-decoration:none;
		text-shadow:0px 1px 0px #333333;
}
.nav-links a {
  color: #fff;
  text-decoration: none;
  margin: 0 0.5rem;
}
.nav-links a:hover {
  text-decoration: underline;
}
.nav-links a.router-link-active {
  color: #ffffff;
  font-weight: bold;
  font-size: 18px;
}
.app {
  max-width: 1200px;
  margin: 0 auto;
  padding: 1rem;
}
.overlay-ui {
  color: #000;
}
.status-connected {
  color: green;
}
.status-text {
  font-size: 1rem;
  font-weight: bold;
  margin-bottom: 0.75rem;
}
.status-connecting {
  color: orange;
}
.status-disconnected {
  color: red;
}
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background-color: rgba(0, 0, 0, 0.6); /* darkened background */
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}
.modal-content {
  background: rgb(255, 171, 171);
  color: #333333;
  padding: 2rem;
  border-radius: 8px;
  max-width: 400px;
  width: 80%;
  text-align: center;
  box-shadow: 0 0 30px rgba(0, 0, 0, 0.3);
}
.modal-content input {
  width: 80%;
  padding: 0.5rem;
  margin-top: 1rem;
  font-size: 1rem;
}
.button-connect {
  box-shadow:inset 0px 1px 0px 0px #8e8ef5;
  background:linear-gradient(to bottom, #379bf2 5%, #271fc6 100%);
  background-color:#373df2;
  border-radius:6px;
  border:1px solid #2118d0;
  display:inline-block;
  cursor:pointer;
  color:#ffffff;
  font-family:Arial;
  font-size:12px;
  font-weight:bold;
  padding:6px 24px;
  text-decoration:none;
  text-shadow:0px 1px 0px #810e05;
}
.button-connect:hover {
  background-color: #131388;
  background: linear-gradient(to bottom, #272fc6 5%, #379bf2 100%);
}
.status-bar {
  margin-top: 1rem;
  font-weight: bold;
}
.debug-panel {
  margin-top: 1rem;
  padding: 0.5rem;
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 4px;
  font-size: 0.75rem;
  font-family: monospace;
}
.debug-content {
  margin-top: 0.5rem;
  color: #0f0;
  white-space: pre-wrap;
  word-break: break-all;
}
.debug-content pre {
  background: #000;
  padding: 0.5rem;
  border-radius: 2px;
  max-height: 200px;
  overflow: auto;
}
</style>
