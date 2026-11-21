<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import ChartPanel from '../components/ChartPanel.vue'
import BarChartPanel from '../components/BarChartPanel.vue'
defineOptions({ name: 'MetricsView' })

const MAX_POINTS = 100

// Connection status
const connected = ref(false)
const ws = ref(null)

// Actor hostnames — discovered via HTTP polling
const actorHostnames = ref([])

// Director metric arrays (chart history)
const directorFpsActual = ref([])
const directorGpuVideoUpload = ref([])
const directorGpuCaptureUpload = ref([])
const directorGpuCompositor = ref([])
const directorGpuGui = ref([])
const directorGpuRenderEverything = ref([])
const directorGpuDmx = ref([])
const directorMachineCpuTime = ref([])
const directorMachineGpuTime = ref([])
const directorMachineGpuMemory = ref([])
const directorMachineDisk = ref([])
const directorProcessMemUsage = ref([])
const directorDiskRead = ref([])
const directorDiskWrite = ref([])

// Advanced tab — CPU vs GPU Processing Time
const directorCpuProfilingTotal = ref([])
const directorGpuProfilingTotal = ref([])
// Advanced tab — Memory Usage (Working Set + Peak)
const directorMemWorking = ref([])
const directorMemPeak = ref([])

// Actor metric storage — keyed by hostname
const actorData = {}

// Subscription confirmation: server id → ref (populated from msg.subscriptions)
const propMapById = {}

function push(arrRef, val) {
  if (arrRef.value.length >= MAX_POINTS) arrRef.value.shift()
  arrRef.value.push(typeof val === 'number' ? val : (val?.value ?? 0))
}

function clearAll() {
  const allRefs = [
    directorFpsActual,
    directorGpuVideoUpload, directorGpuCaptureUpload, directorGpuCompositor, directorGpuGui,
    directorGpuRenderEverything, directorGpuDmx,
    directorMachineCpuTime, directorMachineGpuTime,
    directorMachineGpuMemory, directorMachineDisk, directorProcessMemUsage,
    directorDiskRead, directorDiskWrite,
    directorCpuProfilingTotal, directorGpuProfilingTotal,
    directorMemWorking, directorMemPeak,
  ]
  allRefs.forEach(arr => (arr.value = []))
}

// ---------------------------------------------------------------------------
// Load metrics from backend status.json (fallback when WS not connected)
// ---------------------------------------------------------------------------

function loadStatusMetrics() {
  fetch('/api/status')
    .then(r => r.json())
    .then(data => {
      const d = data?.metrics?.director
      if (d) {
        push(directorFpsActual, d.fps?.actual?.value ?? 0)
        push(directorGpuVideoUpload, d.gpu?.videoUpload?.value ?? 0)
        push(directorGpuCaptureUpload, d.gpu?.captureUpload?.value ?? 0)
        push(directorGpuCompositor, d.gpu?.compositor?.value ?? 0)
        push(directorGpuGui, d.gpu?.gui?.value ?? 0)
        push(directorGpuRenderEverything, d.gpu?.renderEverything?.value ?? 0)
        push(directorGpuDmx, d.gpu?.dmx?.value ?? 0)
        push(directorCpuProfilingTotal, d.cpu?.total?.value ?? 0)
        push(directorGpuProfilingTotal, d.gpu?.total?.value ?? 0)
        push(directorMachineCpuTime, d.machine?.cpuTime?.value ?? 0)
        push(directorMachineGpuTime, d.machine?.gpuTime?.value ?? 0)
        push(directorMachineGpuMemory, d.machine?.gpuMemory?.value ?? 0)
        push(directorMachineDisk, d.machine?.disk?.value ?? 0)
        push(directorProcessMemUsage, d.processMemory?.usage?.value ?? 0)
        const readVal = d.disk?.read?.value ?? 0
        const writeVal = d.disk?.write?.value ?? 0
        push(directorDiskRead, readVal)
        push(directorDiskWrite, writeVal)
        push(directorMemWorking, d.processMemory?.working?.value ?? 0)
        push(directorMemPeak, d.processMemory?.peakUsage?.value ?? 0)
      }
    })
    .catch(() => {})
}

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

function getWsUrl() {
  // Connect directly to the Director (like Pulse does).
  // The browser runs on Windows and can reach the Director directly.
  const storedIP = localStorage.getItem('directorEndpoint')
  const defaultEndpoint = `${import.meta.env.VITE_DIRECTOR_HOST || 'localhost'}:${import.meta.env.VITE_DIRECTOR_PORT || '80'}`
  const endpoint = storedIP || defaultEndpoint
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${endpoint}/api/session/liveupdate`
}

function openWs() {
  if (ws.value) ws.value.close()
  const url = getWsUrl()
  ws.value = new WebSocket(url)

  ws.value.onopen = () => {
    connected.value = true
    sendSubscribeMessages()
    discoverActors()
    startAlertConfigPolling()
  }

  ws.value.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data)
      // Handle subscription confirmation — Pulse-compatible: store all subscriptions
      if (msg.subscriptions) {
        let mapped = 0
        let diskMapped = 0
        for (const sub of msg.subscriptions) {
          const prop = sub.propertyPath ?? sub.property
          const objPath = sub.objectPath
          const isDiskSub = objPath && objPath.includes('Disk')
          if (sub.id != null && objPath && prop) {
            const normalizedObjPath = (objPath ?? '').replace(/\\"/g, '"')
            const isFrontendSub = frontendSubscriptions.some(fs =>
              (fs.object === objPath || fs.object === normalizedObjPath) && fs.properties.includes(prop)
            )
            if (isFrontendSub) {
              subscriptions.push({ id: sub.id, objectPath: objPath, propertyPath: prop })
              frontendSubscriptionsById[sub.id] = { objectPath: objPath, propertyPath: prop }
            }
            const directKey = `${objPath}:${prop}`
            if (directKey in propMap && propMap[directKey] !== null) {
              propMapById[sub.id] = propMap[directKey]
              mapped++
              continue
            }
            const monitorMatch = objPath.match(/find(?:Local|Remote)Monitor\("([^"]+)"(?:,\s*"[^"]+")?\)/)
            const monitorName = monitorMatch ? monitorMatch[1] : null
            if (!monitorName) { continue }
            for (const [mapKey, ref] of Object.entries(propMap)) {
              if (ref === null) continue
              if (!mapKey.includes(prop)) continue
              const isLocal = /findLocalMonitor\("([^"]+)"\)/.exec(mapKey)
              const isRemote = /findRemoteMonitor\("[^"]+", "([^"]+)"\)/.exec(mapKey)
              if (((isLocal && isLocal[1] === monitorName) || (isRemote && isRemote[1] === monitorName))) {
                propMapById[sub.id] = ref
                mapped++
                break
              }
            }
          }
        }
      }
      if (msg.valuesChanged) {
        for (const change of msg.valuesChanged) {
          handleDirectorMetricChange(change.objectPath, change.property, change.id, change.value)
        }
      }
    } catch (e) { /* console.error('[Metrics] onmessage error:', e) */ }
  }

  ws.value.onclose = () => {
    connected.value = false
  }

  ws.value.onerror = (err) => {
    // console.error('[Metrics] WebSocket error', err)
    connected.value = false
  }
}

function send(msg) {
  if (ws.value && ws.value.readyState === WebSocket.OPEN) {
    ws.value.send(JSON.stringify(msg))
  }
}

// Track frontend-initiated subscription objects for matching
const frontendSubscriptions = []

// ---------------------------------------------------------------------------
// Director metric subscriptions (raw WebSocket, Pulse-compatible)
// ---------------------------------------------------------------------------

function sendSubscribeMessages() {
  const Q = String.fromCharCode(34)
  const monitor = (name, props) => ({
    object: `subsystem:MonitoringManager.findLocalMonitor(${Q}${name}${Q})`,
    properties: props,
  })

  const subs = [
    monitor('fps', ['object.seriesAverage("Actual", 1)', 'object.seriesAverage("Actual", 60)']),
    monitor('GPUProfiler', ['object.seriesAverage("Video Upload", 1)', 'object.seriesAverage("Capture Upload", 1)', 'object.seriesAverage("Compositor", 1)', 'object.seriesAverage("GUI", 1)', 'object.seriesAverage("Render Everything", 1)', 'object.seriesAverage("DMX", 1)', 'object.seriesAverage("Total", 1)']),
    monitor('CPU', ['object.seriesAverage("Total", 1)', 'object.seriesAverage("Renderer", 1)', 'object.seriesAverage("Core", 1)']),
    monitor('Machine', ['object.seriesAverage("CPU Time", 1)', 'object.seriesAverage("GPU Time", 1)', 'object.seriesAverage("CPU Memory", 1)', 'object.seriesAverage("GPU Memory", 1)', 'object.seriesAverage("Disk", 1)']),
    monitor('ProcessMemory', ['object.seriesAverage("Peak Usage (MB)", 1)', 'object.seriesAverage("Physical Memory (MB)", 1)', 'object.seriesAverage("Usage (MB)", 1)', 'object.seriesAverage("Working (MB)", 1)']),
    monitor('Disk', ['object.seriesAverage("Read (MB/s)", 1)', 'object.seriesAverage("Write (MB/s)", 1)']),
  ]
  // Track all frontend subscription objects for matching
  for (const s of subs) {
    frontendSubscriptions.push(s)
  }
  // Send all at once
  send({ subscribe: subs[0] })
  send({ subscribe: subs[1] })
  send({ subscribe: subs[2] })
  send({ subscribe: subs[3] })
  send({ subscribe: subs[4] })
  send({ subscribe: subs[5] })
}

const propMap = {}

// Store subscription objects for ID-based lookup (Pulse-compatible pattern)
const subscriptions = []
const frontendSubscriptionsById = {} // id → subscription (frontend only)

function handleDirectorMetricChange(objectPath, property, id, value) {
  if (id == null) return

  const existingRef = propMapById[id]
  if (existingRef) {
    push(existingRef, value)
    updateActiveAlerts()
    return
  }

  const sub = frontendSubscriptionsById[id]
  if (!sub) return

  const monitorMatch = sub.objectPath.match(/find(?:Local|Remote)Monitor\("([^"]+)"(?:,\s*"[^"]+")?\)/)
  const monitorName = monitorMatch ? monitorMatch[1] : null
  if (!monitorName) return

  for (const [mapKey, ref2] of Object.entries(propMap)) {
    if (ref2 === null) continue
    if (!mapKey.includes(sub.propertyPath)) continue
    const isLocal = /findLocalMonitor\("([^"]+)"\)/.exec(mapKey)
    const isRemote = /findRemoteMonitor\("[^"]+", "([^"]+)"\)/.exec(mapKey)
    if (((isLocal && isLocal[1] === monitorName) || (isRemote && isRemote[1] === monitorName))) {
      propMapById[id] = ref2
      push(ref2, value)
      return
    }
  }

  for (const [mapKey, ref2] of Object.entries(propMap)) {
    if (ref2 === null) continue
    if (mapKey.includes(monitorName) && mapKey.includes(sub.propertyPath)) {
      propMapById[id] = ref2
      push(ref2, value)
      return
    }
  }

  // Check if this property is intentionally unmapped (null in propMap)
  const directKey = `${sub.objectPath}:${sub.propertyPath}`
  if (propMap[directKey] === null) {
    return
  }

  updateActiveAlerts()
}

function buildPropMap() {
  const Q = String.fromCharCode(34)
  const monitor = (name) => `subsystem:MonitoringManager.findLocalMonitor(${Q}${name}${Q})`

  // FPS
  propMap[`${monitor('fps')}:object.seriesAverage("Actual", 1)`] = directorFpsActual
  propMap[`${monitor('fps')}:object.seriesAverage("Actual", 60)`] = null // average (not charted)

  // GPUProfiler
  propMap[`${monitor('GPUProfiler')}:object.seriesAverage("Video Upload", 1)`] = directorGpuVideoUpload
  propMap[`${monitor('GPUProfiler')}:object.seriesAverage("Capture Upload", 1)`] = directorGpuCaptureUpload
  propMap[`${monitor('GPUProfiler')}:object.seriesAverage("Compositor", 1)`] = directorGpuCompositor
  propMap[`${monitor('GPUProfiler')}:object.seriesAverage("GUI", 1)`] = directorGpuGui
  propMap[`${monitor('GPUProfiler')}:object.seriesAverage("Render Everything", 1)`] = directorGpuRenderEverything
  propMap[`${monitor('GPUProfiler')}:object.seriesAverage("DMX", 1)`] = directorGpuDmx
  propMap[`${monitor('GPUProfiler')}:object.seriesAverage("Total", 1)`] = directorGpuProfilingTotal

  // CPU
  propMap[`${monitor('CPU')}:object.seriesAverage("Total", 1)`] = directorCpuProfilingTotal
  propMap[`${monitor('CPU')}:object.seriesAverage("Renderer", 1)`] = null
  propMap[`${monitor('CPU')}:object.seriesAverage("Core", 1)`] = null

  // Machine
  propMap[`${monitor('Machine')}:object.seriesAverage("CPU Time", 1)`] = directorMachineCpuTime
  propMap[`${monitor('Machine')}:object.seriesAverage("GPU Time", 1)`] = directorMachineGpuTime
  propMap[`${monitor('Machine')}:object.seriesAverage("CPU Memory", 1)`] = null
  propMap[`${monitor('Machine')}:object.seriesAverage("GPU Memory", 1)`] = directorMachineGpuMemory
  propMap[`${monitor('Machine')}:object.seriesAverage("Disk", 1)`] = directorMachineDisk

  // ProcessMemory
  propMap[`${monitor('ProcessMemory')}:object.seriesAverage("Peak Usage (MB)", 1)`] = directorMemPeak
  propMap[`${monitor('ProcessMemory')}:object.seriesAverage("Physical Memory (MB)", 1)`] = null
  propMap[`${monitor('ProcessMemory')}:object.seriesAverage("Usage (MB)", 1)`] = directorProcessMemUsage
  propMap[`${monitor('ProcessMemory')}:object.seriesAverage("Working (MB)", 1)`] = directorMemWorking

  // Disk
  propMap[`${monitor('Disk')}:object.seriesAverage("Read (MB/s)", 1)`] = directorDiskRead
  propMap[`${monitor('Disk')}:object.seriesAverage("Write (MB/s)", 1)`] = directorDiskWrite
}

// ---------------------------------------------------------------------------
// Actor discovery + metrics via WebSocket (Pulse-compatible)
// ---------------------------------------------------------------------------

async function discoverActors() {
  try {
    const r = await fetch('/api/actors')
    const data = await r.json()
    const newHostnames = data.map(a => a.hostname)
    if (JSON.stringify(newHostnames) !== JSON.stringify(actorHostnames.value)) {
      actorHostnames.value = newHostnames
    }

    // Create refs for new actors
    for (const actor of data) {
      if (!actorData[actor.hostname]) {
        const m = {
          fpsActual: ref([]),
          gpuVideoUpload: ref([]),
          gpuCaptureUpload: ref([]),
          gpuCompositor: ref([]),
          gpuGui: ref([]),
          gpuRenderEverything: ref([]),
          gpuDmx: ref([]),
          machineCpuTime: ref([]),
          machineGpuTime: ref([]),
          gpuLoad: ref([]),
          machineGpuMemory: ref([]),
          machineDisk: ref([]),
          processMemUsage: ref([]),
          diskRead: ref([]),
          diskWrite: ref([]),
          cpuProfilingTotal: ref([]),
          gpuProfilingTotal: ref([]),
          memWorking: ref([]),
          memPeak: ref([]),
        }
        actorData[actor.hostname] = m
        // Register in propMap for ID-based lookup
        buildActorPropMap(actor.hostname, m)
      }
    }
    // Subscribe to remote monitors for new actors
    for (const hostname of actorHostnames.value) {
      if (!actorSubscribed[hostname]) {
        sendRemoteSubscribe(hostname)
        actorSubscribed[hostname] = true
      }
    }
  } catch { /* silently ignore */ }
}

const actorSubscribed = {}

function sendRemoteSubscribe(hostname) {
  const Q = String.fromCharCode(34)
  const remoteMonitor = (name, props) => ({
    object: `subsystem:MonitoringManager.findRemoteMonitor(${Q}${hostname}${Q}, ${Q}${name}${Q})`,
    properties: props,
  })

  const subs = [
    remoteMonitor('fps', [
      'object.seriesAverage("Actual", 1)',
      'object.seriesAverage("Actual", 60)',
    ]),
    remoteMonitor('GPUProfiler', [
      'object.seriesAverage("Video Upload", 1)',
      'object.seriesAverage("Capture Upload", 1)',
      'object.seriesAverage("Compositor", 1)',
      'object.seriesAverage("GUI", 1)',
      'object.seriesAverage("Render Everything", 1)',
      'object.seriesAverage("DMX", 1)',
      'object.seriesAverage("Total", 1)',
    ]),
    remoteMonitor('CPU', [
      'object.seriesAverage("Total", 1)',
      'object.seriesAverage("Renderer", 1)',
      'object.seriesAverage("Core", 1)',
    ]),
    remoteMonitor('Machine', [
      'object.seriesAverage("CPU Time", 1)',
      'object.seriesAverage("GPU Time", 1)',
      'object.seriesAverage("CPU Memory", 1)',
      'object.seriesAverage("GPU Memory", 1)',
      'object.seriesAverage("Disk", 1)',
    ]),
    remoteMonitor('ProcessMemory', [
      'object.seriesAverage("Peak Usage (MB)", 1)',
      'object.seriesAverage("Physical Memory (MB)", 1)',
      'object.seriesAverage("Usage (MB)", 1)',
      'object.seriesAverage("Working (MB)", 1)',
    ]),
    remoteMonitor('Disk', [
      'object.seriesAverage("Read (MB/s)", 1)',
      'object.seriesAverage("Write (MB/s)", 1)',
    ]),
  ]
  // Track all frontend-initiated subscriptions (including actors) for matching
  for (const s of subs) {
    frontendSubscriptions.push(s)
  }
  // Send all at once
  send({ subscribe: subs[0] })
  send({ subscribe: subs[1] })
  send({ subscribe: subs[2] })
  send({ subscribe: subs[3] })
  send({ subscribe: subs[4] })
  send({ subscribe: subs[5] })
}

function buildActorPropMap(hostname, m) {
  const Q = String.fromCharCode(34)
  const remoteMonitor = (name) => `subsystem:MonitoringManager.findRemoteMonitor(${Q}${hostname}${Q}, ${Q}${name}${Q})`

  propMap[`${remoteMonitor('fps')}:object.seriesAverage("Actual", 1)`] = m.fpsActual
  propMap[`${remoteMonitor('fps')}:object.seriesAverage("Actual", 60)`] = null

  propMap[`${remoteMonitor('GPUProfiler')}:object.seriesAverage("Video Upload", 1)`] = m.gpuVideoUpload
  propMap[`${remoteMonitor('GPUProfiler')}:object.seriesAverage("Capture Upload", 1)`] = m.gpuCaptureUpload
  propMap[`${remoteMonitor('GPUProfiler')}:object.seriesAverage("Compositor", 1)`] = m.gpuCompositor
  propMap[`${remoteMonitor('GPUProfiler')}:object.seriesAverage("GUI", 1)`] = m.gpuGui
  propMap[`${remoteMonitor('GPUProfiler')}:object.seriesAverage("Render Everything", 1)`] = m.gpuRenderEverything
  propMap[`${remoteMonitor('GPUProfiler')}:object.seriesAverage("DMX", 1)`] = m.gpuDmx
  propMap[`${remoteMonitor('GPUProfiler')}:object.seriesAverage("Total", 1)`] = m.gpuProfilingTotal

  propMap[`${remoteMonitor('CPU')}:object.seriesAverage("Total", 1)`] = m.cpuProfilingTotal
  propMap[`${remoteMonitor('CPU')}:object.seriesAverage("Renderer", 1)`] = null
  propMap[`${remoteMonitor('CPU')}:object.seriesAverage("Core", 1)`] = null

  propMap[`${remoteMonitor('Machine')}:object.seriesAverage("CPU Time", 1)`] = m.machineCpuTime
  propMap[`${remoteMonitor('Machine')}:object.seriesAverage("GPU Time", 1)`] = m.machineGpuTime
  propMap[`${remoteMonitor('Machine')}:object.seriesAverage("CPU Memory", 1)`] = null
  propMap[`${remoteMonitor('Machine')}:object.seriesAverage("GPU Memory", 1)`] = m.machineGpuMemory
  propMap[`${remoteMonitor('Machine')}:object.seriesAverage("Disk", 1)`] = m.machineDisk

  propMap[`${remoteMonitor('ProcessMemory')}:object.seriesAverage("Peak Usage (MB)", 1)`] = m.memPeak
  propMap[`${remoteMonitor('ProcessMemory')}:object.seriesAverage("Physical Memory (MB)", 1)`] = null
  propMap[`${remoteMonitor('ProcessMemory')}:object.seriesAverage("Usage (MB)", 1)`] = m.processMemUsage
  propMap[`${remoteMonitor('ProcessMemory')}:object.seriesAverage("Working (MB)", 1)`] = m.memWorking

  propMap[`${remoteMonitor('Disk')}:object.seriesAverage("Read (MB/s)", 1)`] = m.diskRead
  propMap[`${remoteMonitor('Disk')}:object.seriesAverage("Write (MB/s)", 1)`] = m.diskWrite
}

// ---------------------------------------------------------------------------
// Tab system
// ---------------------------------------------------------------------------

const tabs = ['Overview', 'Advanced', 'Alerts']
const activeTab = ref(0)
const activeActorTab = ref(-1) // -1 = director, >= 0 = actor index
const entityFilter = ref('all')

// ---------------------------------------------------------------------------
// Alert system
// ---------------------------------------------------------------------------

// Immutable defaults — never mutated, used as reset baseline
const DEFAULT_ALERT_CONFIG = {
  'FPS Actual': { enabled: false, warning: 50, critical: 30, webhook: false },
  'GPU Load': { enabled: false, warning: 80, critical: 90, webhook: false },
  'GPU Compositor': { enabled: false, warning: 5, critical: 10, webhook: false },
  'GPU GUI': { enabled: false, warning: 5, critical: 10, webhook: false },
  'GPU Render Everything': { enabled: false, warning: 10, critical: 20, webhook: false },
  'CPU Time': { enabled: false, warning: 80, critical: 90, webhook: false },
  'GPU Time': { enabled: false, warning: 70, critical: 90, webhook: false },
  'Process Memory Usage': { enabled: false, warning: 8000, critical: 12000, webhook: false },
  'GPU Memory': { enabled: false, warning: 70, critical: 90, webhook: false },
  'Disk Read': { enabled: false, warning: 2500, critical: 3000, webhook: false },
  'Disk Write': { enabled: false, warning: 2500, critical: 3000, webhook: false },
}

// Build alertConfig with defaults + actual structure
function buildAlertConfig() {
  const cfg = {}
  for (const [key, def] of Object.entries(DEFAULT_ALERT_CONFIG)) {
    cfg[key] = { defaults: { ...def }, actual: { ...def } }
  }
  return cfg
}

const defaultAlertConfigs = buildAlertConfig()

// Webhook config
const webhookUrl = ref('')
const webhookChatId = ref('')
const webhookEnabled = ref(false)

// Cooldown map: alertId → timestamp (Pulse pattern: 5min dedup)
const webhookCooldown = new Map()
const WEBHOOK_COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes

// Flicker prevention: once an alert triggers, keep it displayed for 10s
// even if the metric drops back below threshold. This prevents the alert
// badge from constantly appearing/disappearing when values hover near thresholds.
const alertLastTriggeredAt = new Map() // metricName → timestamp when last triggered
const ALERT_DISPLAY_COOLDOWN_MS = 10 * 1000 // 10 seconds

async function sendWebhook(url, alertData, options = {}) {
  const { bypassCooldown = false } = options
  if (!url || !url.trim()) return false
  const alertId = `${alertData.metricPath}-${alertData.severity}-${alertData.threshold}`
  const now = Date.now()
  if (!bypassCooldown) {
    const lastSent = webhookCooldown.get(alertId)
    if (lastSent && now - lastSent < WEBHOOK_COOLDOWN_MS) return false
  }

  try {
    const payload = {
      text: `🚨 Alert: ${alertData.message}`,
      alert: {
        id: alertId,
        severity: alertData.severity,
        metric: alertData.metricTitle,
        path: alertData.metricPath,
        message: alertData.message,
        timestamp: new Date(alertData.timestamp).toISOString(),
        value: alertData.value,
        unit: alertData.unit,
        threshold: alertData.threshold,
      },
    }
    // Telegram requires chat_id
    if (url.includes('telegram.org')) {
      payload.chat_id = webhookChatId.value
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) return false
    if (!bypassCooldown) webhookCooldown.set(alertId, now)
    return true
  } catch (err) {
    return false
  }
}

async function sendTestWebhook() {
  if (!webhookEnabled.value || !webhookUrl.value || !webhookUrl.value.trim()) return
  try {
    const res = await fetch('/api/alerts/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Test alert from D3Reporter Metrics' }),
    })
    const data = await res.json()
    if (data.ok) return true
    return false
  } catch (err) {
    return false
  }
}

function getEntityName() {
  if (activeActorTab.value === -1) return 'Director'
  const hostname = actorHostnames.value[activeActorTab.value]
  return hostname || 'Unknown'
}

const alertConfig = ref(buildAlertConfig())
const activeAlerts = ref([])

function saveAlertConfig() {
  // Deep-strip Vue proxies via JSON round-trip, then send clean defaults+actual
  const plain = JSON.parse(JSON.stringify(alertConfig.value))
  const serialized = {}
  for (const [key, val] of Object.entries(plain)) {
    if (key === 'webhookUrl' || key === 'webhookChatId' || key === 'webhookEnabled') continue
    serialized[key] = { defaults: { ...val.defaults }, actual: { ...val.actual } }
  }
  // Include webhook settings so the backend preserves them across polls
  serialized.webhookUrl = webhookUrl.value
  serialized.webhookChatId = webhookChatId.value
  serialized.webhookEnabled = webhookEnabled.value
  fetch('/api/alerts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(serialized),
  }).catch(() => {})
}

function saveWebhookConfig() {
  fetch('/api/alerts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webhookUrl: webhookUrl.value, webhookChatId: webhookChatId.value, webhookEnabled: webhookEnabled.value }),
  }).catch(() => {})
}

function loadAlertConfig() {
  fetch('/api/alerts')
    .then(r => {
      console.log('[Config] polling fetch status:', r.status)
      return r.json()
    })
    .then(data => {
      if (data && typeof data === 'object') {
        // Start fresh from defaults, overlay backend data onto .actual
        alertConfig.value = JSON.parse(JSON.stringify(defaultAlertConfigs))
        for (const key of Object.keys(data)) {
          if (key === 'webhookUrl' || key === 'webhookChatId' || key === 'webhookEnabled') continue
          if (typeof data[key] === 'object' && data[key] !== null && !Array.isArray(data[key])) {
            // New structure: { defaults, actual }
            if ('actual' in data[key]) {
              alertConfig.value[key].actual = { ...alertConfig.value[key].actual, ...data[key].actual }
            }
            // Legacy structure: flat { enabled, warning, critical, webhook }
            else {
              alertConfig.value[key].actual = { ...alertConfig.value[key].actual, ...data[key] }
            }
          }
        }
        if (typeof data.webhookUrl === 'string') webhookUrl.value = data.webhookUrl
        if (typeof data.webhookChatId === 'string') webhookChatId.value = data.webhookChatId
        if (typeof data.webhookEnabled === 'boolean') webhookEnabled.value = data.webhookEnabled
        // console.log('[Config] loaded. FPS Actual:', JSON.stringify(alertConfig.value['FPS Actual']))
      }
    })
    .catch(e => console.error('[Config] polling error:', e))
}

// Poll alert config every 2s so changes from OpenClaw appear without refresh
let alertConfigPoll = null
function startAlertConfigPolling() {
  console.log('[Config] starting polling')
  loadAlertConfig()
  alertConfigPoll = setInterval(() => {
    console.log('[Config] polling tick...')
    loadAlertConfig()
  }, 2000)
}

function stopAlertConfigPolling() {
  if (alertConfigPoll) { clearInterval(alertConfigPoll); alertConfigPoll = null }
}

const alertMetricKeys = {
  'FPS Actual': 'fpsActual',
  'GPU Load': 'machineGpuTime',
  'GPU Compositor': 'gpuCompositor',
  'GPU GUI': 'gpuGui',
  'GPU Render Everything': 'gpuRenderEverything',
  'CPU Time': 'machineCpuTime',
  'GPU Time': 'machineGpuTime',
  'Process Memory Usage': 'processMemUsage',
  'GPU Memory': 'machineGpuMemory',
  'Disk Read': 'diskRead',
  'Disk Write': 'diskWrite',
}

function getMetricRef(key) {
  if (activeActorTab.value === -1) {
    const map = {
      fpsActual: directorFpsActual,
      gpuCompositor: directorGpuCompositor,
      gpuGui: directorGpuGui,
      gpuRenderEverything: directorGpuRenderEverything,
      machineCpuTime: directorMachineCpuTime,
      machineGpuTime: directorMachineGpuTime,
      machineGpuMemory: directorMachineGpuMemory,
      diskRead: directorDiskRead,
      diskWrite: directorDiskWrite,
      gpuVideoUpload: directorGpuVideoUpload,
      gpuCaptureUpload: directorGpuCaptureUpload,
      gpuDmx: directorGpuDmx,
      machineDisk: directorMachineDisk,
      processMemUsage: directorProcessMemUsage,
      directorCpuProfilingTotal: directorCpuProfilingTotal,
      directorGpuProfilingTotal: directorGpuProfilingTotal,
      directorMemWorking: directorMemWorking,
      directorMemPeak: directorMemPeak,
    }
    return map[key]
  }
  const hostname = actorHostnames.value[activeActorTab.value]
  if (hostname && actorData[hostname]) {
    const map = {
      fpsActual: actorData[hostname].fpsActual,
      gpuCompositor: actorData[hostname].gpuCompositor,
      gpuGui: actorData[hostname].gpuGui,
      gpuRenderEverything: actorData[hostname].gpuRenderEverything,
      machineCpuTime: actorData[hostname].machineCpuTime,
      machineGpuTime: actorData[hostname].machineGpuTime,
      gpuLoad: actorData[hostname].gpuLoad,
      machineGpuMemory: actorData[hostname].machineGpuMemory,
      diskRead: actorData[hostname].diskRead,
      diskWrite: actorData[hostname].diskWrite,
      gpuVideoUpload: actorData[hostname].gpuVideoUpload,
      gpuCaptureUpload: actorData[hostname].gpuCaptureUpload,
      gpuDmx: actorData[hostname].gpuDmx,
      machineDisk: actorData[hostname].machineDisk,
      processMemUsage: actorData[hostname].processMemUsage,
      directorCpuProfilingTotal: actorData[hostname].cpuProfilingTotal,
      directorGpuProfilingTotal: actorData[hostname].gpuProfilingTotal,
      directorMemWorking: actorData[hostname].memWorking,
      directorMemPeak: actorData[hostname].memPeak,
    }
    return map[key]
  }
  return undefined
}

function getAlertMetricValue(metricName) {
  const key = alertMetricKeys[metricName]
  if (!key) return 0
  const ref = getMetricRef(key)
  if (!ref || ref.value.length === 0) return 0
  return ref.value[ref.value.length - 1]
}

let _alertsLastTick = 0
function updateActiveAlerts() {
  // Throttle: max 10 ticks/sec to prevent webhook flood
  const now = Date.now()
  if (now - _alertsLastTick < 100) return
  _alertsLastTick = now

  const entityName = getEntityName()
  now = Date.now()

  // Compute which alerts would be active this tick
  const currentAlerts = new Map() // metricName → alert object
  for (const [metricName, config] of Object.entries(alertConfig.value)) {
    const actual = config.actual || config
    const defaults = config.defaults || config
    const isEnabled = actual.enabled ?? defaults.enabled
    const isWebhook = actual.webhook ?? defaults.webhook
    if (!isEnabled) continue
    const value = getAlertMetricValue(metricName)
    const critical = actual.critical ?? defaults.critical
    const warning = actual.warning ?? defaults.warning
    const isLowerWorse = metricName === 'FPS Actual'
    const meetsCritical = isLowerWorse ? (value <= critical) : (value >= critical)
    const meetsWarning = isLowerWorse ? (value <= warning) : (value >= warning)
    const severityLabel = isLowerWorse ? 'low' : 'high'

    if (meetsCritical || meetsWarning) {
      const severity = meetsCritical && !meetsWarning ? 'critical' : 'warning'
      currentAlerts.set(metricName, { metric: metricName, severity, value })

      // Notify backend relay endpoint — it handles state transition + cooldown
      if (isWebhook && webhookEnabled.value && webhookUrl.value) {
        fetch('/api/alerts/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            severity,
            metric: metricName,
            message: `${metricName} ${severityLabel}: ${value.toFixed(1)} (threshold: ${meetsCritical ? critical : warning})`,
            value,
            unit: metricName === 'FPS Actual' ? 'fps' : 'MB',
            threshold: meetsCritical ? critical : warning,
          }),
        }).catch(() => {})
      }
      alertLastTriggeredAt.set(metricName, now)
    }
  }

  // Compare with previous alerts — only update if state changed
  const prev = activeAlerts.value || []
  const prevMap = new Map()
  for (const a of prev) prevMap.set(a.metric, a)

  // Build the final alerts array with cooldown logic
  const finalAlerts = []
  const seen = new Set()

  // 1. Keep alerts that are still active
  for (const [name, alert] of currentAlerts) {
    finalAlerts.push(alert)
    seen.add(name)
  }

  // 2. For cleared alerts: keep displayed if within cooldown window
  for (const a of prev) {
    if (seen.has(a.metric)) continue
    const lastTriggered = alertLastTriggeredAt.get(a.metric)
    if (lastTriggered && now - lastTriggered < ALERT_DISPLAY_COOLDOWN_MS) {
      // Still in cooldown — keep it displayed
      finalAlerts.push(a)
    } else {
      // Cooldown expired — remove it
      alertLastTriggeredAt.delete(a.metric)
    }
  }

  // Only update if the set of active alerts actually changed (by metric name + severity)
  const prevKeys = prev.map(a => `${a.metric}:${a.severity}`)
  const curKeys = finalAlerts.map(a => `${a.metric}:${a.severity}`)
  const hasChanged = prevKeys.length !== curKeys.length ||
    prevKeys.some(k => !curKeys.includes(k))
  if (hasChanged) {
    activeAlerts.value = finalAlerts
  }
}

// ---------------------------------------------------------------------------
// Overview chart data
// ---------------------------------------------------------------------------

function safeArr(r) {
  if (!r || r.value === undefined) return []
  return [...r.value.map(v => typeof v === 'object' ? (v.value ?? 0) : v)]
}

const overviewCpuLoad = computed(() => {
  const r = getMetricRef('machineCpuTime')
  const arr = (r && r.value !== undefined) ? [...r.value.map(v => typeof v === 'object' ? (v.value ?? 0) : v)] : []
  return [arr]
})

const overviewGpuLoad = computed(() => {
  const r = getMetricRef('machineGpuTime')
  return [safeArr(r)]
})

const overviewMemoryUsage = computed(() => {
  const r = getMetricRef('processMemUsage')
  return [safeArr(r)]
})

const overviewFps = computed(() => {
  return [safeArr(getMetricRef('fpsActual'))]
})

// Advanced tab computed
const advancedCpuGpuTime = computed(() => {
  return [safeArr(getMetricRef('directorCpuProfilingTotal')), safeArr(getMetricRef('directorGpuProfilingTotal'))]
})

const advancedMemoryUsage = computed(() => {
  return [safeArr(getMetricRef('directorMemWorking'))]
})

const advancedDiskActivity = computed(() => {
  return [safeArr(getMetricRef('directorDiskRead')), safeArr(getMetricRef('directorDiskWrite'))]
})

// Helper: get the latest numeric value from a ref (handles both primitives and {value} objects)
function latest(arrRef) {
  if (!arrRef || arrRef.value === undefined || arrRef.value.length === 0) return 0
  const v = arrRef.value
  const last = v[v.length - 1]
  const val = typeof last === 'object' ? (last.value ?? 0) : last
  return typeof val === 'number' && !isNaN(val) ? val : 0
}

// Overview values — read directly from the same chart data sources
// so they always stay in sync with what the charts display.
const overviewValues = computed(() => ({
  fpsActual: latest(getMetricRef('fpsActual')),
  machineCpuTime: latest(getMetricRef('machineCpuTime')),
  machineGpuTime: latest(getMetricRef('machineGpuTime')),
  gpuLoad: latest(getMetricRef('machineGpuTime')),
  processMemUsage: latest(getMetricRef('processMemUsage')),
}))

const advancedCpuGpuValues = computed(() => {
  const cpuRef = getMetricRef('directorCpuProfilingTotal')
  const gpuRef = getMetricRef('directorGpuProfilingTotal')
  return {
    cpu: latest(cpuRef),
    gpu: latest(gpuRef),
  }
})

const advancedMemValues = computed(() => ({
  current: latest(getMetricRef('processMemUsage')),
  working: latest(getMetricRef('directorMemWorking')),
  peak: latest(getMetricRef('directorMemPeak')),
}))

const advancedDiskValues = computed(() => ({
  read: latest(getMetricRef('directorDiskRead')),
  write: latest(getMetricRef('directorDiskWrite')),
}))

// Alert config groups
const cpuAlertConfigs = computed(() => ({
  'CPU Time': alertConfig.value['CPU Time'],
}))

const gpuAlertConfigs = computed(() => ({
  'GPU Time': alertConfig.value['GPU Time'],
}))

const memoryAlertConfigs = computed(() => ({
  'Process Memory Usage': alertConfig.value['Process Memory Usage'],
}))

const fpsAlertConfigs = computed(() => ({
  'FPS Actual': alertConfig.value['FPS Actual'],
}))

watch(alertConfig, () => {
  // Clear cooldown when config changes so old thresholds don't block new alerts
  webhookCooldown.clear()
  updateActiveAlerts()
  saveAlertConfig()
}, { deep: true })

watch([webhookUrl, webhookEnabled], () => {
  saveWebhookConfig()
}, { deep: true })

// Refresh alerts whenever the active tab or entity changes
watch([activeTab, activeActorTab], () => {
  updateActiveAlerts()
})

function resetAlerts() {
  alertConfig.value = JSON.parse(JSON.stringify(defaultAlertConfigs))
  webhookUrl.value = ''
  webhookChatId.value = ''
  webhookEnabled.value = false
  webhookCooldown.clear()
  saveAlertConfig()
  saveWebhookConfig()
}

// Lifecycle
// ---------------------------------------------------------------------------

onMounted(() => {
  clearAll()
  buildPropMap()
  // Load from status.json first so there's data even before WS connects
  loadStatusMetrics()
  openWs()
})

onUnmounted(() => {
  stopAlertConfigPolling()
  if (ws.value) {
    ws.value.onclose = null
    ws.value.close()
  }
})
</script>

<template>
  <div class="metrics-view">
    <!-- Tab bar -->
    <div class="tab-bar">
      <button
        v-for="(tab, i) in tabs"
        :key="tab"
        :class="['tab', { active: activeTab === i }]"
        @click="activeTab = i"
      >
        <span class="tab-label">{{ tab }}</span>
        <span v-if="tab === 'Alerts' && activeAlerts.length > 0" class="alert-badge">
          {{ activeAlerts.length }}
        </span>
      </button>
    </div>

    <!-- Entity selector (Director / Actors dropdown) -->
    <div v-if="actorHostnames.length > 0" class="entity-selector">
      <select
        v-model="activeActorTab"
        class="entity-dropdown"
      >
        <option :value="-1">Director</option>
        <option v-for="(hostname, i) in actorHostnames" :key="hostname" :value="i">
          {{ hostname }}
        </option>
      </select>
    </div>

    <!-- Overview tab: 4 charts with alert configs below each -->
    <template v-if="activeTab === 0">
      <div class="overview-grid">
        <!-- CPU Load (top-left) -->
        <div class="card overview-card">
          <div class="card-title">
            <span>CPU Load</span>
            <span class="unit">%</span>
          </div>
          <ChartPanel
            title="CPU Load"
            unit="%"
            :data-arrays="overviewCpuLoad"
            :series-names="['CPU Time']"
            :series-colors="['#FF6DF0']"
            :thresholds="[{ warning: alertConfig['CPU Time']?.actual?.warning ?? 80, critical: alertConfig['CPU Time']?.actual?.critical ?? 90 }]"
          />
          <div class="metric-table">
            <div class="metric-row header">
              <span>Metric</span>
              <span>Value</span>
              <span>Unit</span>
            </div>
            <div class="metric-row odd">
              <span class="metric-label">CPU Time</span>
              <span class="metric-value">{{ (overviewValues.machineCpuTime ?? 0).toFixed(1) }}</span>
              <span class="metric-unit">%</span>
            </div>
          </div>
          <div class="alert-configs overview-configs">
            <div v-for="(config, metric) in cpuAlertConfigs" :key="metric" class="alert-config-card">
              <div class="config-header">
                <span class="config-metric">{{ metric }}</span>
                <label class="toggle">
                  <input type="checkbox" v-model="config.actual.enabled" />
                  <span class="toggle-track"></span>
                </label>
              </div>
              <div class="config-body">
                <div class="config-row">
                  <label>Warning</label>
                  <div class="config-values">
                    <span class="default-val" :title="`Original default`">{{ config.defaults.warning }}</span>
                    <input type="number" v-model.number="config.actual.warning" class="config-input" :disabled="!config.actual.enabled" />
                  </div>
                </div>
                <div class="config-row">
                  <label>Critical</label>
                  <div class="config-values">
                    <span class="default-val" :title="`Original default`">{{ config.defaults.critical }}</span>
                    <input type="number" v-model.number="config.actual.critical" class="config-input" :disabled="!config.actual.enabled" />
                  </div>
                </div>
                <div class="config-row">
                  <label class="checkbox-label">
                    <input type="checkbox" v-model="config.actual.webhook" :disabled="!config.actual.enabled || !webhookEnabled || !webhookUrl" />
                    Send webhook
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>
        <!-- GPU Load (top-right) -->
        <div class="card overview-card">
          <div class="card-title">
            <span>GPU Load</span>
            <span class="unit">%</span>
          </div>
          <ChartPanel
            title="GPU Load"
            unit="%"
            :data-arrays="overviewGpuLoad"
            :series-names="['GPU Load']"
            :series-colors="['#FF6DF0']"
            :thresholds="[{ warning: alertConfig['GPU Load']?.actual?.warning ?? 80, critical: alertConfig['GPU Load']?.actual?.critical ?? 90 }]"
          />
          <div class="metric-table">
            <div class="metric-row header">
              <span>Metric</span>
              <span>Value</span>
              <span>Unit</span>
            </div>
            <div class="metric-row odd">
              <span class="metric-label">GPU Load</span>
              <span class="metric-value">{{ (overviewValues.gpuLoad ?? 0).toFixed(1) }}</span>
              <span class="metric-unit">%</span>
            </div>
          </div>
          <div class="alert-configs overview-configs">
            <div v-for="(config, metric) in gpuAlertConfigs" :key="metric" class="alert-config-card">
              <div class="config-header">
                <span class="config-metric">{{ metric }}</span>
                <label class="toggle">
                  <input type="checkbox" v-model="config.actual.enabled" />
                  <span class="toggle-track"></span>
                </label>
              </div>
              <div class="config-body">
                <div class="config-row">
                  <label>Warning</label>
                  <div class="config-values">
                    <span class="default-val" :title="`Original default`">{{ config.defaults.warning }}</span>
                    <input type="number" v-model.number="config.actual.warning" class="config-input" :disabled="!config.actual.enabled" />
                  </div>
                </div>
                <div class="config-row">
                  <label>Critical</label>
                  <div class="config-values">
                    <span class="default-val" :title="`Original default`">{{ config.defaults.critical }}</span>
                    <input type="number" v-model.number="config.actual.critical" class="config-input" :disabled="!config.actual.enabled" />
                  </div>
                </div>
                <div class="config-row">
                  <label class="checkbox-label">
                    <input type="checkbox" v-model="config.actual.webhook" :disabled="!config.actual.enabled || !webhookEnabled || !webhookUrl" />
                    Send webhook
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>
        <!-- Memory Usage (bottom-left) -->
        <div class="card overview-card">
          <div class="card-title">
            <span>Memory Usage</span>
            <span class="unit">MB</span>
          </div>
          <ChartPanel
            title="Memory"
            unit="MB"
            :data-arrays="overviewMemoryUsage"
            :series-names="['Process Memory Usage']"
            :series-colors="['#FF6DF0']"
            :thresholds="[{ warning: alertConfig['Process Memory Usage']?.actual?.warning ?? 8000, critical: alertConfig['Process Memory Usage']?.actual?.critical ?? 12000 }]"
          />
          <div class="metric-table">
            <div class="metric-row header">
              <span>Metric</span>
              <span>Value</span>
              <span>Unit</span>
            </div>
            <div class="metric-row odd">
              <span class="metric-label">Process Memory Usage</span>
              <span class="metric-value">{{ (overviewValues.processMemUsage ?? 0).toFixed(1) }}</span>
              <span class="metric-unit">MB</span>
            </div>
          </div>
          <div class="alert-configs overview-configs">
            <div v-for="(config, metric) in memoryAlertConfigs" :key="metric" class="alert-config-card">
              <div class="config-header">
                <span class="config-metric">{{ metric }}</span>
                <label class="toggle">
                  <input type="checkbox" v-model="config.actual.enabled" />
                  <span class="toggle-track"></span>
                </label>
              </div>
              <div class="config-body">
                <div class="config-row">
                  <label>Warning</label>
                  <div class="config-values">
                    <span class="default-val" :title="`Original default`">{{ config.defaults.warning }}</span>
                    <input type="number" v-model.number="config.actual.warning" class="config-input" :disabled="!config.actual.enabled" />
                  </div>
                </div>
                <div class="config-row">
                  <label>Critical</label>
                  <div class="config-values">
                    <span class="default-val" :title="`Original default`">{{ config.defaults.critical }}</span>
                    <input type="number" v-model.number="config.actual.critical" class="config-input" :disabled="!config.actual.enabled" />
                  </div>
                </div>
                <div class="config-row">
                  <label class="checkbox-label">
                    <input type="checkbox" v-model="config.actual.webhook" :disabled="!config.actual.enabled || !webhookEnabled || !webhookUrl" />
                    Send webhook
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>
        <!-- Frame Rate (bottom-right) -->
        <div class="card overview-card">
          <div class="card-title">
            <span>Frame Rate</span>
            <span class="unit">fps</span>
          </div>
          <ChartPanel
            title="FPS"
            unit="fps"
            :data-arrays="overviewFps"
            :series-names="['FPS Actual']"
            :series-colors="['#FF6DF0']"
            :thresholds="[{ warning: alertConfig['FPS Actual']?.actual?.warning ?? 50, critical: alertConfig['FPS Actual']?.actual?.critical ?? 30 }]"
          />
          <div class="metric-table">
            <div class="metric-row header">
              <span>Metric</span>
              <span>Value</span>
              <span>Unit</span>
            </div>
            <div class="metric-row">
              <span class="metric-label">FPS Actual</span>
              <span class="metric-value">{{ (overviewValues.fpsActual ?? 0).toFixed(1) }}</span>
              <span class="metric-unit">fps</span>
            </div>
          </div>
          <div class="alert-configs overview-configs">
            <div v-for="(config, metric) in fpsAlertConfigs" :key="metric" class="alert-config-card">
              <div class="config-header">
                <span class="config-metric">{{ metric }}</span>
                <label class="toggle">
                  <input type="checkbox" v-model="config.actual.enabled" />
                  <span class="toggle-track"></span>
                </label>
              </div>
              <div class="config-body">
                <div class="config-row">
                  <label>Warning</label>
                  <div class="config-values">
                    <span class="default-val" :title="`Original default`">{{ config.defaults.warning }}</span>
                    <input type="number" v-model.number="config.actual.warning" class="config-input" :disabled="!config.actual.enabled" />
                  </div>
                </div>
                <div class="config-row">
                  <label>Critical</label>
                  <div class="config-values">
                    <span class="default-val" :title="`Original default`">{{ config.defaults.critical }}</span>
                    <input type="number" v-model.number="config.actual.critical" class="config-input" :disabled="!config.actual.enabled" />
                  </div>
                </div>
                <div class="config-row">
                  <label class="checkbox-label">
                    <input type="checkbox" v-model="config.actual.webhook" :disabled="!config.actual.enabled || !webhookEnabled || !webhookUrl" />
                    Send webhook
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Advanced tab: CPU vs GPU, Memory, Disk -->
    <template v-if="activeTab === 1">
      <div class="advanced-grid">
        <!-- CPU vs GPU Processing Time -->
        <div class="card overview-card">
          <div class="card-title">
            <span>CPU vs GPU Processing Time</span>
            <span class="unit">ms</span>
          </div>
          <ChartPanel
            title="CPU vs GPU"
            unit="ms"
            :data-arrays="advancedCpuGpuTime"
            :series-names="['CPU Total', 'GPU Total']"
            :series-colors="['#6a5acd', '#FF6DF0']"
          />
          <div class="metric-table">
            <div class="metric-row header">
              <span>Metric</span>
              <span>Value</span>
              <span>Unit</span>
            </div>
            <div class="metric-row odd">
              <span class="metric-label">CPU Total</span>
              <span class="metric-value">{{ (advancedCpuGpuValues?.cpu ?? 0).toFixed(1) }}</span>
              <span class="metric-unit">ms</span>
            </div>
            <div class="metric-row">
              <span class="metric-label">GPU Total</span>
              <span class="metric-value">{{ (advancedCpuGpuValues?.gpu ?? 0).toFixed(1) }}</span>
              <span class="metric-unit">ms</span>
            </div>
          </div>
        </div>
        <!-- Memory Usage -->
        <div class="card overview-card">
          <div class="card-title">
            <span>Memory Usage</span>
            <span class="unit">MB</span>
          </div>
          <BarChartPanel
            title="Memory"
            unit="MB"
            :current="advancedMemValues?.current ?? 0"
            :working="advancedMemValues?.working ?? 0"
            :peak="advancedMemValues?.peak ?? 0"
          />
          <div class="metric-table">
            <div class="metric-row header">
              <span>Metric</span>
              <span>Value</span>
              <span>Unit</span>
            </div>
            <div class="metric-row odd">
              <span class="metric-label">Current Usage</span>
              <span class="metric-value">{{ (advancedMemValues?.current ?? 0).toFixed(1) }}</span>
              <span class="metric-unit">MB</span>
            </div>
            <div class="metric-row">
              <span class="metric-label">Working Set</span>
              <span class="metric-value">{{ (advancedMemValues?.working ?? 0).toFixed(1) }}</span>
              <span class="metric-unit">MB</span>
            </div>
            <div class="metric-row odd">
              <span class="metric-label">Peak Usage</span>
              <span class="metric-value">{{ (advancedMemValues?.peak ?? 0).toFixed(1) }}</span>
              <span class="metric-unit">MB</span>
            </div>
          </div>
        </div>
        <!-- Disk Activity -->
        <div class="card overview-card">
          <div class="card-title">
            <span>Disk Activity</span>
            <span class="unit">MB/s</span>
          </div>
          <ChartPanel
            title="Disk I/O"
            unit="MB/s"
            :data-arrays="advancedDiskActivity"
            :series-names="['Read', 'Write']"
            :series-colors="['#FF6DF0', '#6a5acd']"
          />
          <div class="metric-table">
            <div class="metric-row header">
              <span>Metric</span>
              <span>Value</span>
              <span>Unit</span>
            </div>
            <div class="metric-row odd">
              <span class="metric-label">Read</span>
              <span class="metric-value">{{ (advancedDiskValues?.read ?? 0).toFixed(1) }}</span>
              <span class="metric-unit">MB/s</span>
            </div>
            <div class="metric-row">
              <span class="metric-label">Write</span>
              <span class="metric-value">{{ (advancedDiskValues?.write ?? 0).toFixed(1) }}</span>
              <span class="metric-unit">MB/s</span>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Alerts tab: active alerts only -->
    <template v-if="activeTab === 2">
      <div class="alert-section">
        <!-- Webhook config -->
        <div class="webhook-config-card">
          <div class="config-header">
            <span class="config-metric">Webhook (Telegram / Discord / Slack)</span>
            <label class="toggle">
              <input type="checkbox" v-model="webhookEnabled" :disabled="!webhookUrl" />
              <span class="toggle-track"></span>
            </label>
          </div>
          <div class="config-body">
            <div class="config-row">
              <label>URL</label>
              <input
                type="text"
                v-model="webhookUrl"
                placeholder="https://api.telegram.org/bot.../sendMessage"
                class="config-input webhook-input"
                @input="saveWebhookConfig"
              />
            </div>
            <div class="config-row">
              <label>Chat ID</label>
              <input
                type="text"
                v-model="webhookChatId"
                placeholder="903646471"
                class="config-input webhook-input"
                @input="saveWebhookConfig"
              />
            </div>
          </div>
        </div>

        <div class="section-header">
          <h3>Active Alerts</h3>
          <button class="btn-reset" @click="resetAlerts">Reset All Defaults</button>
        </div>
        <div v-if="activeAlerts.length > 0" class="active-alerts">
          <div v-for="(alert, i) in activeAlerts" :key="i" :class="['alert-item', alert.severity]">
            <span class="alert-severity">{{ alert.severity }}</span>
            <span class="alert-metric">{{ alert.metric }}</span>
            <span class="alert-value">{{ (alert.value ?? 0).toFixed(1) }}</span>
          </div>
        </div>
        <div v-else class="all-normal">
          <span class="status-dot success"></span>
          All systems normal.
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.metrics-view {
  padding: 0;
}

/* Connection status bar */
.connection-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  font-size: 12px;
  font-weight: 500;
}

.connection-bar.connected {
  background: rgba(115, 191, 105, 0.1);
  color: #73BF69;
}

.connection-bar.disconnected {
  background: rgba(242, 73, 92, 0.1);
  color: #F2495C;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.status-dot.online {
  background: #73BF69;
}

.status-dot.offline {
  background: #F2495C;
}

/* Tab bar */
.tab-bar {
  display: flex;
  gap: 0;
  background: #1a1a1a;
  border-bottom: 1px solid #333;
  overflow-x: auto;
}

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 20px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: #888;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: color 0.2s, border-color 0.2s;
  white-space: nowrap;
  font-family: inherit;
}

.tab:hover {
  color: #ccc;
  background: rgba(255, 255, 255, 0.04);
}

.tab.active {
  color: #fff;
  border-bottom-color: #fff;
}

.alert-badge {
  background: #F2495C;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  min-width: 16px;
  height: 16px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
}

/* Entity selector dropdown */
.entity-selector {
  padding: 8px 16px;
  background: #161616;
  border-bottom: 1px solid #2a2a2a;
}

.entity-dropdown {
  background: #2a2a2a;
  border: 1px solid #444;
  border-radius: 4px;
  color: #e0e0e0;
  font-size: 13px;
  padding: 6px 12px;
  cursor: pointer;
  font-family: inherit;
  outline: none;
}

.entity-dropdown:focus {
  border-color: #73BF69;
}

.entity-dropdown option {
  background: #2a2a2a;
  color: #e0e0e0;
}

/* Overview grid */
.overview-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  padding: 16px;
}

.overview-card {
  margin: 0;
}

/* Advanced grid: 2 on top, 1 full width below */
.advanced-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  padding: 16px;
}

.advanced-grid .overview-card:nth-child(3) {
  grid-column: 1 / -1;
}

/* Cards */
.card {
  background: #1E1E1E;
  border: 1px solid #333;
  border-radius: 8px;
  margin: 16px;
  overflow: hidden;
}

.card-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 12px 16px 0;
}

.card-title span:first-child {
  color: #e0e0e0;
  font-size: 14px;
  font-weight: 600;
}

.card-title .unit {
  color: #666;
  font-size: 12px;
}

/* Alert section */
.alert-section {
  margin: 16px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.section-header h3 {
  color: #e0e0e0;
  font-size: 16px;
  margin: 0;
}

.btn-reset {
  padding: 6px 12px;
  background: #2a2a2a;
  border: 1px solid #444;
  border-radius: 4px;
  color: #888;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
}

.btn-reset:hover {
  background: #333;
  color: #ccc;
}

.alert-hint {
  color: #666;
  font-size: 12px;
  margin: 0 0 16px;
}

/* Active alerts */
.active-alerts h4 {
  color: #e0e0e0;
  font-size: 14px;
  margin: 0 0 8px;
}

.active-alerts {
  margin-bottom: 24px;
}

.alert-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: #1E1E1E;
  border: 1px solid #333;
  border-radius: 6px;
  margin-bottom: 6px;
  cursor: pointer;
  transition: background 0.2s;
}

.alert-item:hover {
  background: #252525;
}

.alert-item.warning {
  border-left: 3px solid #F2CC04;
}

.alert-item.critical {
  border-left: 3px solid #F2495C;
}

.alert-severity {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  padding: 2px 6px;
  border-radius: 3px;
  color: #000;
}

.alert-severity.warning {
  background: #F2CC04;
}

.alert-severity.critical {
  background: #F2495C;
  color: #fff;
}

.alert-metric {
  color: #e0e0e0;
  font-size: 13px;
  flex: 1;
}

.alert-value {
  color: #888;
  font-size: 12px;
  font-family: monospace;
}

.alert-detail {
  color: #555;
  font-size: 11px;
}

.all-normal {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #73BF69;
  font-size: 13px;
  margin-bottom: 24px;
}

.status-dot.success {
  background: #73BF69;
  opacity: 0.5;
}

/* Alert config cards */
.alert-configs {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}

.alert-config-card {
  background: #1E1E1E;
  border: 1px solid #333;
  border-radius: 6px;
  padding: 12px;
}

/* Webhook config card in Alerts tab */
.webhook-config-card {
  background: #1E1E1E;
  border: 1px solid #333;
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 16px;
}

.webhook-row {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}

.webhook-input {
  width: 100%;
  font-size: 11px;
  font-family: monospace;
}

.config-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.config-metric {
  color: #e0e0e0;
  font-size: 13px;
  font-weight: 500;
}

/* Toggle switch */
.toggle {
  display: flex;
  align-items: center;
  cursor: pointer;
}

.toggle input {
  display: none;
}

.toggle-track {
  width: 36px;
  height: 20px;
  background: #444;
  border-radius: 10px;
  position: relative;
  transition: background 0.2s;
}

.toggle input:checked + .toggle-track {
  background: #73BF69;
}

.toggle-track::after {
  content: '';
  position: absolute;
  width: 16px;
  height: 16px;
  background: #fff;
  border-radius: 50%;
  top: 2px;
  left: 2px;
  transition: transform 0.2s;
}

.toggle input:checked + .toggle-track::after {
  transform: translateX(16px);
}

.config-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.config-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.config-row label {
  color: #888;
  font-size: 12px;
}

.config-values {
  display: flex;
  align-items: center;
  gap: 6px;
}

.default-val {
  color: #555;
  font-size: 11px;
  font-family: monospace;
  min-width: 32px;
  text-align: right;
  user-select: none;
}

.config-input {
  width: 80px;
  padding: 4px 8px;
  background: #2a2a2a;
  border: 1px solid #444;
  border-radius: 4px;
  color: #e0e0e0;
  font-size: 12px;
  font-family: monospace;
  text-align: right;
}

.config-input:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #888;
  font-size: 12px;
  cursor: pointer;
}

.checkbox-label input {
  accent-color: #73BF69;
}

/* Metric tables */
.metric-table {
  border-top: 1px solid #333;
}

.metric-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid #2a2a2a;
}

.metric-row.header {
  color: #666;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding-bottom: 6px;
}

.metric-row.odd {
  background: rgba(255, 255, 255, 0.02);
}

.metric-label {
  color: #e0e0e0;
  font-size: 12px;
}

.metric-value {
  color: #ccc;
  font-size: 12px;
  font-family: monospace;
  text-align: right;
}

.metric-unit {
  color: #666;
  font-size: 11px;
  font-family: monospace;
}

</style>
