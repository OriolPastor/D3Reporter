// websocket_service.js
// Servicio: conecta con el Director de Disguise vía WebSocket,
// suscribe métricas y timeline, escribe status.json unificado (salud + timeline).
//
// Architecture:
// - Backend connects directly to Director WebSocket for metrics (MonitoringManager) + timeline (GuiSystem) → status.json
// - Frontend connects directly to Director WebSocket for all metrics + timeline (independent WS connection)
// - Backend serves REST API (/api/status, /api/timeline, etc.) and static frontend
// - No relay: both sides connect independently to Director
// Configuración: .env.local (DIRECTOR_HOST, DIRECTOR_PORT).

const dotenv = require('dotenv');
const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// 1. Variables de entorno
// ---------------------------------------------------------------------------
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const DIRECTOR_HOST = process.env.DIRECTOR_HOST;
const DIRECTOR_PORT = parseInt(process.env.DIRECTOR_PORT, 10) || 80;

if (!DIRECTOR_HOST) {
  console.error('ERROR: Falta DIRECTOR_HOST en .env.local');
  process.exit(1);
}

console.log(`Director: ${DIRECTOR_HOST}:${DIRECTOR_PORT}`);

// ---------------------------------------------------------------------------
// 2. Configuración
// ---------------------------------------------------------------------------
const STATUS_FILE = path.join(__dirname, '..', 'status.json');
const ALERT_CONFIG_FILE = path.join(__dirname, '..', 'alert-config.json');
let httpServer = null;

// ---------------------------------------------------------------------------
// 3. Estado global
// ---------------------------------------------------------------------------
let ws = null;
let backendSubscriptions = []; // backend's own subscriptions
let subscribeObjectMap = {}; // subscription id → original subscribe request's object field (unused — kept for reference)
let liveMetrics = null; // removed — all metrics now stored in statusData.metrics
let directorHostname = null; // internal — not serialized to status.json
const DEFAULT_ALERT_DEFS = {
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
};

function buildAlertConfig() {
  const cfg = {};
  for (const [key, def] of Object.entries(DEFAULT_ALERT_DEFS)) {
    cfg[key] = { defaults: { ...def }, actual: { ...def } };
  }
  return cfg;
}

let alertConfig = buildAlertConfig();
alertConfig.webhookEnabled = false;

// ---------------------------------------------------------------------------
// 3b. Webhook sending (Telegram / Discord / Slack compatible)
// ---------------------------------------------------------------------------
const WEBHOOK_COOLDOWN_MS = 5 * 60 * 1000;
const webhookCooldownMap = new Map(); // alertId → timestamp (legacy, kept for safety)

// Per-metric cooldown: track when each metric last triggered an alert
// Prevents flood when values hover around thresholds
const metricLastTriggered = {};
const currentlyAlertingMetrics = new Set(); // exposed for relay endpoint
const METRIC_TRIGGER_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes per metric

function sendWebhook(url, payload) {
  if (!url || !url.trim()) return Promise.resolve(false);
  const body = JSON.stringify(payload);
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
    .then((res) => {
      if (!res.ok) {
        console.error(`[Webhook] failed: ${res.status}`);
        return false;
      }
      console.log('[Webhook] sent OK');
      return true;
    })
    .catch((err) => {
      console.error(`[Webhook] error: ${err.message}`);
      return false;
    });
}

function checkAndSendAlerts() {
  // Metric paths — same as in the frontend
  const ALERT_METRIC_PATHS = {
    'FPS Actual': ['fps', 'actual'],
    'GPU Load': ['gpu', 'total'],
    'GPU Compositor': ['gpu', 'compositor'],
    'GPU GUI': ['gpu', 'gui'],
    'GPU Render Everything': ['gpu', 'renderEverything'],
    'CPU Time': ['machine', 'cpuTime'],
    'GPU Time': ['machine', 'gpuTime'],
    'Process Memory Usage': ['processMemory', 'usage'],
    'GPU Memory': ['machine', 'gpuMemory'],
    'Disk Read': ['disk', 'read'],
    'Disk Write': ['disk', 'write'],
  };

  function resolveMetricValue(name) {
    const path = ALERT_METRIC_PATHS[name];
    if (!path) return undefined;
    const dir = statusData.metrics?.director;
    if (!dir) return undefined;
    let obj = dir;
    for (const seg of path) {
      if (obj == null) return undefined;
      obj = obj[seg];
    }
    return obj?.value;
  }

  // Compute which metrics are currently alerting
  const newAlerting = new Set();
  for (const [metricName, cfg] of Object.entries(alertConfig)) {
    if (!(metricName in DEFAULT_ALERT_DEFS)) continue;
    const actual = cfg.actual || cfg;
    if (!actual.enabled) continue;

    const val = resolveMetricValue(metricName);
    if (val == null) continue;

    const isLowerWorse = metricName === 'FPS Actual';
    const meetsCritical = isLowerWorse ? (val <= actual.critical) : (val >= actual.critical);
    const meetsWarning = isLowerWorse ? (val <= actual.warning) : (val >= actual.warning);

    if (meetsCritical || meetsWarning) {
      newAlerting.add(metricName);
    }
  }

  // Update currentlyAlertingMetrics — preserve relay-added entries so they
  // survive across backend ticks (prevents state guard from re-allowing sends)
  const existing = new Set(currentlyAlertingMetrics);
  currentlyAlertingMetrics.clear();
  for (const name of existing) currentlyAlertingMetrics.add(name);
  for (const name of newAlerting) currentlyAlertingMetrics.add(name);

  // Keep cooldown for metrics that already triggered — prevents rapid
  // re-trigger when a metric clears and re-triggers within the cooldown window.
  // metricLastTriggered entries persist until they naturally expire.
}


let statusData = {
  metrics: {
    director: {
      fps: { actual: { value: 0, unit: 'fps' }, average: { value: 0, unit: 'fps' } },
      gpu: {
        videoUpload: { value: 0, unit: 'ms' },
        captureUpload: { value: 0, unit: 'ms' },
        compositor: { value: 0, unit: 'ms' },
        gui: { value: 0, unit: 'ms' },
        renderEverything: { value: 0, unit: 'ms' },
        dmx: { value: 0, unit: 'ms' },
        total: { value: 0, unit: 'ms' }
      },
      cpu: {
        total: { value: 0, unit: '%' },
        renderer: { value: 0, unit: '%' },
        core: { value: 0, unit: '%' }
      },
      machine: {
        cpuTime: { value: 0, unit: '%' },
        gpuTime: { value: 0, unit: '%' },
        cpuMemory: { value: 0, unit: 'MB' },
        gpuMemory: { value: 0, unit: 'MB' },
        disk: { value: 0, unit: 'MB/s' }
      },
      processMemory: {
        peakUsage: { value: 0, unit: 'MB' },
        physicalMemory: { value: 0, unit: 'MB' },
        usage: { value: 0, unit: 'MB' },
        working: { value: 0, unit: 'MB' }
      },
      disk: {
        read: { value: 0, unit: 'MB/s' },
        write: { value: 0, unit: 'MB/s' }
      }
    },
    actors: {}
  },
  transport: {
    playing: false,
    isLooping: false,
  },
};

// Timeline data — estructura calco de CurrentVideoAssets.vue + TrackDetail.vue
let timelineData = {
  playhead: 0,
  activeLayers: [],
  layerNames: [],
  videoAssetList: [],
  layerReported: [],
  trackLayers: [],
};

// Datos crudos de suscripciones dinámicas (id calco del reference):
//   layerData   = { layer0: { value }, layer1: { value }, ... }
//   videoAssetData = { asset0: { value }, asset1: { value }, ... }
//   trackLayerData = { trackLayer0: { value }, ... }
//   layerVideoAssetData = { layerVideoAsset0: { value }, ... }
//   layerStartTimeData = { startTime0: { value }, ... }
//   layerEndTimeData = { endTime0: { value }, ... }
let layerData = {};
let videoAssetData = {};
// WebSocket track layer data (populated by handleTimelineChanges)
let trackLayerData = {};
let layerVideoAssetData = {};
let layerStartTimeData = {};
let layerEndTimeData = {};
let dynamicSubscriptionsSent = false;
let subscribedRemoteMonitors = new Set(); // track actors we've subscribed to
let reconnectTimer = null;
let startTime = Date.now();
let metricIdToObjPath = {};
let subscribeIdToObjectPath = {}; // subscription id → original subscribe request's object field
let subscribeIdToPropertyPath = {}; // subscription id → property path (for valuesChanged resolution)

// ---------------------------------------------------------------------------
// 4. Utilidades HTTP
// ---------------------------------------------------------------------------

function loadAlertConfig() {
  try {
    const raw = fs.readFileSync(ALERT_CONFIG_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      // Merge: start from current defaults, overlay disk data onto .actual
      for (const key of Object.keys(alertConfig)) {
        if (data[key] && typeof data[key] === 'object' && !Array.isArray(data[key])) {
          // New structure: { defaults, actual }
          if ('actual' in data[key]) {
            alertConfig[key].actual = { ...alertConfig[key].actual, ...data[key].actual };
          }
          // Legacy structure: flat { enabled, warning, critical, webhook }
          else {
            alertConfig[key].actual = { ...alertConfig[key].actual, ...data[key] };
          }
        }
      }
      // Also load webhook fields (not in alert defs)
      for (const key of Object.keys(data)) {
        if (!(key in alertConfig)) alertConfig[key] = data[key];
      }
    }
  } catch (e) {
    // Use defaults — silent
  }
}

function saveAlertConfig() {
  try {
    fs.writeFileSync(ALERT_CONFIG_FILE, JSON.stringify(alertConfig, null, 2));
  } catch (e) {
    console.error(`Failed to save alert config: ${e.message}`);
  }
}

function httpPostJson(host, port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const payload = JSON.stringify(body);
    const req = http.request(
      { hostname: host, port: port, path: urlPath, method: 'POST',
        timeout: 5000, agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        res.setTimeout(5000);
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { resolve({ raw: data }); }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout HTTP POST')); });
    req.write(payload);
    req.end();
  });
}

function httpGetJson(host, port, urlPath) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const req = http.request(
      { hostname: host, port: port, path: urlPath, method: 'GET', timeout: 5000, agent: false },
      (res) => {
        res.setTimeout(5000);
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`JSON inválido: ${body}`)); }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout HTTP')); });
    req.end();
  });
}

async function fetchSessionStatus() {
  try {
    const data = await httpGetJson(DIRECTOR_HOST, DIRECTOR_PORT, '/api/session/status/session');
    if (!data?.result) return { director: null, actors: [] };
    return { director: data.result.director, actors: data.result.actors || [] };
  } catch (err) {
    return { director: null, actors: [] };
  }
}

async function fetchHealthStatus() {
  try {
    const data = await httpGetJson(DIRECTOR_HOST, DIRECTOR_PORT, '/api/session/status/health');
    if (!data?.result) return {};
    const map = {};
    for (const entry of data.result) {
      if (entry.machine?.hostname) {
        const key = entry.machine.hostname.toLowerCase();
        map[key] = {
          averageFPS: entry.status?.averageFPS ?? 0,
          videoDroppedFrames: entry.status?.videoDroppedFrames ?? 0,
          videoMissedFrames: entry.status?.videoMissedFrames ?? 0,
          states: entry.status?.states ?? [],
        };
      }
    }
    return map;
  } catch (err) {
    return {};
  }
}

// ---------------------------------------------------------------------------
// 5. status.json
// ---------------------------------------------------------------------------

function formatTimecode(seconds) {
  if (typeof seconds !== 'number' || isNaN(seconds)) return '00:00:00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const fps = 60;
  const frame = Math.floor(((seconds % 1) * fps) % fps);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(frame).padStart(2, '0')}`;
}

function buildStatusData() {
  const now = new Date().toISOString();

  // Sync metrics → health for director
  if (statusData.health?.director) {
    statusData.health.director.averageFPS = statusData.metrics.director.fps?.average?.value ?? statusData.health.director.averageFPS;
  }
  // Sync metrics → health for actors
  for (const [host, actor] of Object.entries(statusData.metrics.actors || {})) {
    if (statusData.health?.[host]) {
      statusData.health[host].averageFPS = actor.fps?.average?.value ?? statusData.health[host].averageFPS;
    }
  }

  // Timeline section
  statusData.timeline = {
    playhead: formatTimecode(timelineData.playhead),
    playing: statusData.transport.playing,
    activeLayers: timelineData.layerReported.map((item) => ({
      name: item.layer,
      asset: item.path,
    })),
    trackLayers: [...timelineData.trackLayers].sort((a, b) => {
      const aStart = Number(a.startTime ?? a.start ?? 0);
      const bStart = Number(b.startTime ?? b.start ?? 0);
      return aStart - bStart;
    }).map((tl) => {
      const start = Number(tl.startTime ?? tl.start ?? 0);
      const end = Number(tl.endTime ?? tl.end ?? 0);
      const isActive = timelineData.playhead >= start && timelineData.playhead < end;
      return {
        name: tl.trackLayer ?? tl.name ?? '(Unnamed)',
        asset: tl.videoAsset ?? tl.asset ?? '(No asset)',
        start: formatTimecode(start),
        end: formatTimecode(end),
        duration: tl.duration ?? end - start,
        active: isActive ? new Date().toLocaleTimeString() : '',
      };
    }),
  };

  // Timestamps on metrics
  statusData.metrics.director.ts = now;
  for (const [host, actor] of Object.entries(statusData.metrics.actors || {})) {
    actor.ts = now;
  }

  // Write alertConfig
  try {
    fs.writeFileSync(ALERT_CONFIG_FILE, JSON.stringify(alertConfig, null, 2));
  } catch (e) {
    console.error(`Failed to save alert config: ${e.message}`);
  }

  // Write everything
  fs.writeFileSync(STATUS_FILE, JSON.stringify(statusData, null, 2));
}

async function updateStatusFromHealth() {
  const session = await fetchSessionStatus();
  const healthData = await fetchHealthStatus();

  const directorHost = session.director?.hostname || DIRECTOR_HOST;
  directorHostname = directorHost;

  // Build health section directly from fetchHealthStatus result
  statusData.health = {};
  if (directorHost) {
    const dh = healthData[directorHost.toLowerCase()] || {};
    statusData.health.director = {
      hostname: directorHost,
      status: (dh.states || []).some(s => s.severity === 'offline' || s.severity === 'error') ? 'unhealthy' : 'healthy',
      averageFPS: dh.averageFPS ?? 0,
      videoDroppedFrames: dh.videoDroppedFrames ?? 0,
      videoMissedFrames: dh.videoMissedFrames ?? 0,
      states: (dh.states || []).map((s) => ({
        category: s.category, severity: s.severity, name: s.name, detail: s.detail,
      })),
    };
  }
  for (const [host, h] of Object.entries(healthData)) {
    if (host === (directorHost || DIRECTOR_HOST).toLowerCase()) continue;
    statusData.health[host] = {
      hostname: host,
      status: (h.states || []).some(s => s.severity === 'offline' || s.severity === 'error') ? 'unhealthy' : 'healthy',
      averageFPS: h.averageFPS ?? 0,
      videoDroppedFrames: h.videoDroppedFrames ?? 0,
      videoMissedFrames: h.videoMissedFrames ?? 0,
      states: (h.states || []).map((s) => ({
        category: s.category, severity: s.severity, name: s.name, detail: s.detail,
      })),
    };
  }

  buildStatusData();
}

// ---------------------------------------------------------------------------
// 6. WebSocket / LiveUpdate
// ---------------------------------------------------------------------------

function connect() {
  const url = `ws://${DIRECTOR_HOST}:${DIRECTOR_PORT}/api/session/liveupdate`;
  console.log(`Conectando a ${url} ...`);

  ws = new WebSocket(url);

  ws.on('open', async () => {
    console.log('WebSocket abierto.');
    startTime = Date.now();
    dynamicSubscriptionsSent = false;
    layerData = {};
    videoAssetData = {};
    metricIdToObjPath = {};
    subscribeIdToObjectPath = {};
    subscribeIdToPropertyPath = {};
    timelineData.layerReported = [];
    timelineData.trackLayers = [];
    // Fetch session + health once on connect (no polling)
    await updateStatusFromHealth();
    // Discover actors and subscribe to remote metrics (no polling)
    await pollActorMetrics();
    resubscribeAll();
  });

  ws.on('message', (data) => {
    const raw = data.toString();
    handleMessage(raw);
  });

  ws.on('error', (err) => console.error(`Error WebSocket: ${err.message}`));

  ws.on('close', () => {
    console.log('WebSocket cerrado. Reintentando...');
    scheduleReconnect();
  });
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    // Track ALL backend-initiated subscription IDs for classification
    if (msg.subscribe && msg.subscribe.id && msg.subscribe.object) {
      subscribeIdToObjectPath[String(msg.subscribe.id)] = msg.subscribe.object;
      // Ensure MonitoringManager subs have updateFrequencyMs
      if (msg.subscribe.object.includes('findLocalMonitor') ||
          msg.subscribe.object.includes('findRemoteMonitor')) {
        if (!msg.subscribe.configuration) {
          msg.subscribe.configuration = { updateFrequencyMs: 1000 };
        }
      }
    }
    ws.send(JSON.stringify(msg));
  }
}

// ---------------------------------------------------------------------------
// 2c. WebSocket relay helpers
// ---------------------------------------------------------------------------
// Relay removed: frontend connects directly to Director WebSocket.
// Backend subscribes independently to MonitoringManager + GuiSystem for status.json.

/**
 * Mapea subscription id → propertyPath para resolver valuesChanged.
 */
function buildBackendIdMap() {
  const map = {};
  for (const sub of backendSubscriptions) {
    map[sub.id] = sub.propertyPath;
  }
  return map;
}

function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); }
  catch (e) { console.error(`Mensaje inválido: ${raw}`); return; }

  if (msg.error) {
    // Ignore subscription errors for unavailable monitors
    const errMsg = msg.error?.message ?? '';
    if (!errMsg.includes('Unable to subscribe') && !errMsg.includes('No object found')) {
      return;
    }
    return;
  }

  // Confirmación de suscripciones
  if (msg.subscriptions) {
    const newSubs = msg.subscriptions.map((s) => {
      // s.objectPath from server is the full subscribed object path.
      // Map server ID → objectPath for valuesChanged resolution by objectPath.
      subscribeIdToObjectPath[String(s.id)] = s.objectPath;
      subscribeIdToPropertyPath[String(s.id)] = s.propertyPath;
      return { id: s.id, objectPath: s.objectPath, propertyPath: s.propertyPath };
    });

    for (const ns of newSubs) {
      const idx = backendSubscriptions.findIndex((s) => s.id === ns.id);
      if (idx !== -1) backendSubscriptions[idx] = ns;
      else backendSubscriptions.push(ns);
    }
  }

  // Valores actualizados — backend procesa MonitoringManager + GuiSystem.
  if (msg.valuesChanged) {
    const changes = msg.valuesChanged;

    // Enrich all changes with objPath/propPath (calco del old code: procesa todos).
    const enriched = changes.map((change) => {
      const objPath = subscribeIdToObjectPath[String(change.id)] || null;
      const propPath = subscribeIdToPropertyPath[String(change.id)] || change.property;
      return { ...change, _objectPath: objPath, _propPath: propPath };
    });

    // Classify: MonitoringManager → metrics, GuiSystem → timeline.
    const metricChanges = [];
    const guiChanges = [];
    for (const change of enriched) {
      const objPath = change._objectPath;
      if (objPath && (objPath.includes('findLocalMonitor') || objPath.includes('findRemoteMonitor'))) {
        metricChanges.push(change);
      } else {
        guiChanges.push(change);
      }
    }

    if (metricChanges.length > 0) {
      handleValuesChanged(metricChanges);
    }

    if (guiChanges.length > 0) {
      handleTimelineChanges(guiChanges);
    }
  }
}

/**
 * Procesa cambios de métricas y los almacena en statusData.metrics.
 */
function handleValuesChanged(changes) {
  // Categorize changes by objectPath
  const localMonitorChanges = [];
  const remoteMonitorChanges = [];
  for (const change of changes) {
    const objPath = change._objectPath;
    const propPath = change._propPath;
    if (!objPath) { continue; }

    if (objPath.includes('findLocalMonitor')) {
      localMonitorChanges.push(change);
    } else if (objPath.includes('findRemoteMonitor')) {
      remoteMonitorChanges.push(change);
    }
  }

  // --- Remote metrics (Pulse-compatible per actor) ---
  const m = statusData.metrics;
  for (const change of remoteMonitorChanges) {
    const hostMatch = change._objectPath.match(/findRemoteMonitor\("([^"]+)"/);
    const propMatch = change._propPath.match(/findRemoteMonitor\("([^"]+)"/);
    let hostname = hostMatch ? hostMatch[1] : (propMatch ? propMatch[1] : DIRECTOR_HOST);
    hostname = hostname.replace(/:d3$/, ''); // MSI:d3 → MSI
    // Skip the director — it goes into metrics.directector, not actors
    if (hostname === directorHostname) continue;
    if (!m.actors[hostname]) {
      m.actors[hostname] = {
        ts: '',
        fps: {
          actual: { value: 0, unit: 'fps' },
          average: { value: 0, unit: 'fps' }
        },
        gpu: {
          videoUpload: { value: 0, unit: 'ms' },
          captureUpload: { value: 0, unit: 'ms' },
          compositor: { value: 0, unit: 'ms' },
          gui: { value: 0, unit: 'ms' },
          renderEverything: { value: 0, unit: 'ms' },
          dmx: { value: 0, unit: 'ms' },
          total: { value: 0, unit: 'ms' }
        },
        cpu: {
          total: { value: 0, unit: '%' },
          renderer: { value: 0, unit: '%' },
          core: { value: 0, unit: '%' }
        },
        machine: {
          cpuTime: { value: 0, unit: '%' },
          gpuTime: { value: 0, unit: '%' },
          cpuMemory: { value: 0, unit: 'MB' },
          gpuMemory: { value: 0, unit: 'MB' },
          disk: { value: 0, unit: 'MB/s' }
        },
        processMemory: {
          peakUsage: { value: 0, unit: 'MB' },
          physicalMemory: { value: 0, unit: 'MB' },
          usage: { value: 0, unit: 'MB' },
          working: { value: 0, unit: 'MB' }
        },
        disk: {
          read: { value: 0, unit: 'MB/s' },
          write: { value: 0, unit: 'MB/s' }
        }
      };
    }
    const a = m.actors[hostname];
    const objPath = change._objectPath;
    const prop = change._propPath;
    const val = change.value;

    if (objPath.includes('findRemoteMonitor("') && objPath.includes('", "fps")')) {
      if (prop.includes('"Actual", 1)')) a.fps.actual.value = val;
      else if (prop.includes('"Actual", 60)')) a.fps.average.value = val;
    } else if (objPath.includes('findRemoteMonitor("') && objPath.includes('", "GPUProfiler")')) {
      if (prop.includes('"Video Upload"')) a.gpu.videoUpload.value = val;
      else if (prop.includes('"Capture Upload"')) a.gpu.captureUpload.value = val;
      else if (prop.includes('"Compositor"')) a.gpu.compositor.value = val;
      else if (prop.includes('"GUI"')) a.gpu.gui.value = val;
      else if (prop.includes('"Render Everything"')) a.gpu.renderEverything.value = val;
      else if (prop.includes('"DMX"')) a.gpu.dmx.value = val;
      else if (prop.includes('"Total"')) a.gpu.total.value = val;
    } else if (objPath.includes('findRemoteMonitor("') && objPath.includes('", "CPU")')) {
      if (prop.includes('"Total"')) a.cpu.total.value = val;
      else if (prop.includes('"Renderer"')) a.cpu.renderer.value = val;
      else if (prop.includes('"Core"')) a.cpu.core.value = val;
    } else if (objPath.includes('findRemoteMonitor("') && objPath.includes('", "Machine")')) {
      if (prop.includes('CPU Time')) a.machine.cpuTime.value = val;
      else if (prop.includes('GPU Time')) a.machine.gpuTime.value = val;
      else if (prop.includes('CPU Memory')) a.machine.cpuMemory.value = val;
      else if (prop.includes('GPU Memory')) a.machine.gpuMemory.value = val;
      else if (prop.includes('"Disk"')) a.machine.disk.value = val;
    } else if (objPath.includes('findRemoteMonitor("') && objPath.includes('", "ProcessMemory")')) {
      if (prop.includes('Peak Usage')) a.processMemory.peakUsage.value = val;
      else if (prop.includes('Physical Memory')) a.processMemory.physicalMemory.value = val;
      else if (prop.includes('Usage')) a.processMemory.usage.value = val;
      else if (prop.includes('Working')) a.processMemory.working.value = val;
    } else if (objPath.includes('findRemoteMonitor("') && objPath.includes('", "Disk")')) {
      if (prop.includes('Read')) a.disk.read.value = val;
      else if (prop.includes('Write')) a.disk.write.value = val;
    }
  }

  // --- Local metrics (Pulse-compatible) → statusData.metrics.director ---
  const director = statusData.metrics.director;
  for (const change of localMonitorChanges) {
    const objPath = change._objectPath;
    const prop = change._propPath;
    const val = change.value;

    if (objPath.includes('findLocalMonitor("fps")')) {
      if (prop.includes('"Actual", 1)')) director.fps.actual.value = val;
      else if (prop.includes('"Actual", 60)')) director.fps.average.value = val;
    } else if (objPath.includes('findLocalMonitor("GPUProfiler")')) {
      if (prop.includes('"Video Upload"')) director.gpu.videoUpload.value = val;
      else if (prop.includes('"Capture Upload"')) director.gpu.captureUpload.value = val;
      else if (prop.includes('"Compositor"')) director.gpu.compositor.value = val;
      else if (prop.includes('"GUI"')) director.gpu.gui.value = val;
      else if (prop.includes('"Render Everything"')) director.gpu.renderEverything.value = val;
      else if (prop.includes('"DMX"')) director.gpu.dmx.value = val;
      else if (prop.includes('"Total"')) director.gpu.total.value = val;
    } else if (objPath.includes('findLocalMonitor("CPU")')) {
      if (prop.includes('"Total"')) director.cpu.total.value = val;
      else if (prop.includes('"Renderer"')) director.cpu.renderer.value = val;
      else if (prop.includes('"Core"')) director.cpu.core.value = val;
    } else if (objPath.includes('findLocalMonitor("Machine")')) {
      if (prop.includes('CPU Time')) director.machine.cpuTime.value = val;
      else if (prop.includes('GPU Time')) director.machine.gpuTime.value = val;
      else if (prop.includes('CPU Memory')) director.machine.cpuMemory.value = val;
      else if (prop.includes('GPU Memory')) director.machine.gpuMemory.value = val;
      else if (prop.includes('"Disk"')) director.machine.disk.value = val;
    } else if (objPath.includes('findLocalMonitor("ProcessMemory")')) {
      if (prop.includes('Peak Usage')) director.processMemory.peakUsage.value = val;
      else if (prop.includes('Physical Memory')) director.processMemory.physicalMemory.value = val;
      else if (prop.includes('Usage')) director.processMemory.usage.value = val;
      else if (prop.includes('Working')) director.processMemory.working.value = val;
    } else if (objPath.includes('findLocalMonitor("Disk")')) {
      if (prop.includes('Read')) director.disk.read.value = val;
      else if (prop.includes('Write')) director.disk.write.value = val;
    }
  }

  buildStatusData();

  // Check alerts and send webhooks on metric updates
  checkAndSendAlerts();

  const actorCount = Object.keys(statusData.metrics.actors).length;
}

// ---------------------------------------------------------------------------
// 5b. Timeline — calco de CurrentVideoAssets.vue + TrackDetail.vue
// ---------------------------------------------------------------------------

/**
 * Procesa cambios de timeline siguiendo exactamente el patrón de
 * D3TrackReporter/src/components/CurrentVideoAssets.vue:
 *
 *   1. activeLayers → actualizar timelineData.activeLayers + disparar
 *      suscripciones dinámicas a nombre y asset de cada capa.
 *   2. object.player.activeLayers[N].name → layerData
 *   3. object.player.activeLayers[N].fields[10].sequence.keys → videoAssetData
 *   4. Recomputar layerNames, videoAssetList, layerReported.
 */
function handleTimelineChanges(changes) {
  const idMap = buildBackendIdMap();

  for (const change of changes) {
    // Use _propPath from subscribe confirmation (server-assigned ID mapping),
    // fall back to idMap[change.id] for direct backend subs without relay.
    const prop = change._propPath || idMap[change.id] || 'unknown';

    // --- tRender (playhead) ---
    if (prop === 'object.player.tRender') {
      timelineData.playhead = typeof change.value === 'number' ? change.value : 0;
      continue;
    }

    // --- Track description ---
    if (prop === 'object.track.description') {
      continue;
    }

    // --- activeLayers (disparador de suscripciones dinámicas) ---
    // Usa prop.includes para ser compatible con cualquier sub-property.
    // Solo procesa la raíz (no incluye .name ni .fields).
    if (prop.includes('activeLayers') && !prop.includes('.name') && !prop.includes('.fields')) {
      const arr = change.value || [];
      timelineData.activeLayers = arr;

      const count = arr.length;

      // Suscripción dinámica a nombres y assets de cada capa activa.
      // Se envía cada vez que cambia el count (igual que el watch con
      // immediate: true de CurrentVideoAssets.vue).
      if (count > 0) {
        const props = [];
        for (let i = 0; i < count; i++) {
          props.push(`object.player.activeLayers[${i}].name`);
          props.push(`object.player.activeLayers[${i}].fields[10].sequence.keys`);
        }
        layerData = {};
        videoAssetData = {};
        send({ subscribe: { object: 'GuiSystem.currentTransportManager', properties: props } });
        dynamicSubscriptionsSent = true;
      } else {
        // Sin capas activas: limpiar todo.
        layerData = {};
        videoAssetData = {};
        timelineData.layerReported = [];
        dynamicSubscriptionsSent = false;
      }
      continue;
    }

    // --- Nombres de capa: object.player.activeLayers[N].name ---
    if (prop.includes('activeLayers[') && prop.includes('.name')) {
      const match = prop.match(/activeLayers\[(\d+)\]/);
      if (match) {
        const idx = parseInt(match[1], 10);
        if (!layerData[idx]) layerData[idx] = {};
        layerData[idx].name = change.value;
        computeLayerNames();
        computeLayerReported();
      }
      continue;
    }

    // --- Assets: object.player.activeLayers[N].fields[10].sequence.keys ---
    if (prop.includes('activeLayers[') && prop.includes('fields[10].sequence.keys')) {
      const match = prop.match(/activeLayers\[(\d+)\]/);
      if (match) {
        const idx = parseInt(match[1], 10);
        videoAssetData[idx] = change.value;
        computeVideoAssetList();
        computeLayerReported();
      }
      continue;
    }

    // --- Track layers: object.track.layers (disparador de suscripciones dinámicas) ---
    // Usa prop.includes para ser compatible con cualquier sub-property.
    // Solo procesa la raíz (no incluye .name ni .fields ni .tStart ni .tEnd).
    if (prop.includes('track.layers') && !prop.includes('.name') && !prop.includes('.fields') && !prop.includes('.tStart') && !prop.includes('.tEnd')) {
      const arr = change.value || [];
      const count = arr.length;

      // Suscripción dinámica a nombre, asset, start y end de cada capa del track.
      // Se envía cada vez que cambia el count (igual que el watch con
      // immediate: true de TrackDetail.vue).
      if (count > 0) {
        const props = [];
        for (let i = 0; i < count; i++) {
          props.push(`object.track.layers[${i}].name`);
          props.push(`object.track.layers[${i}].fields[10].sequence.keys`);
          props.push(`object.track.layers[${i}].tStart`);
          props.push(`object.track.layers[${i}].tEnd`);
        }
        trackLayerData = {};
        layerVideoAssetData = {};
        layerStartTimeData = {};
        layerEndTimeData = {};
        send({ subscribe: { object: 'GuiSystem.currentTransportManager', properties: props } });
      } else {
        // Sin capas en el track: limpiar todo.
        trackLayerData = {};
        layerVideoAssetData = {};
        layerStartTimeData = {};
        layerEndTimeData = {};
        timelineData.trackLayers = [];
      }
      continue;
    }

     // --- Nombre de capa del track: object.track.layers[N].name ---
    if (prop.includes('track.layers[') && prop.includes('.name')) {
      const match = prop.match(/track\.layers\[(\d+)\]/);
      if (match) {
        const idx = parseInt(match[1], 10);
        if (!trackLayerData[idx]) trackLayerData[idx] = {};
        trackLayerData[idx].name = change.value;
        computeTrackLayers();
      }
      continue;
    }

    // --- Asset del track: object.track.layers[N].fields[10].sequence.keys ---
    if (prop.includes('track.layers[') && prop.includes('fields[10].sequence.keys')) {
      const match = prop.match(/track\.layers\[(\d+)\]/);
      if (match) {
        const idx = parseInt(match[1], 10);
        layerVideoAssetData[idx] = change.value;
        computeTrackLayers();
      }
      continue;
    }

    // --- Start time: object.track.layers[N].tStart ---
    if (prop.includes('track.layers[') && prop.includes('.tStart')) {
      const match = prop.match(/track\.layers\[(\d+)\]/);
      if (match) {
        const idx = parseInt(match[1], 10);
        layerStartTimeData[idx] = change.value;
        computeTrackLayers();
      }
      continue;
    }

    // --- End time: object.track.layers[N].tEnd ---
    if (prop.includes('track.layers[') && prop.includes('.tEnd')) {
      const match = prop.match(/track\.layers\[(\d+)\]/);
      if (match) {
        const idx = parseInt(match[1], 10);
        layerEndTimeData[idx] = change.value;
        computeTrackLayers();
      }
      continue;
    }
  }
}

/**
 * Computed layerNames — calco de CurrentVideoAssets.vue.
 * Convierte layerData crudo en array plano de { id, name }.
 */
function computeLayerNames() {
  if (!layerData || Object.keys(layerData).length === 0) {
    timelineData.layerNames = [];
    return;
  }
  timelineData.layerNames = Object.entries(layerData).map(([key, rawValue]) => {
    const name = typeof rawValue === 'string' ? rawValue
      : (rawValue?.name ?? '(Unnamed)');
    return { id: key, name: name.length > 0 ? name : '(Unnamed)' };
  });
}

/**
 * Computed videoAssetList — calco de CurrentVideoAssets.vue.
 * Transforma fields[10].sequence.keys → path limpio del asset.
 */
function computeVideoAssetList() {
  if (!videoAssetData || Object.keys(videoAssetData).length === 0) {
    timelineData.videoAssetList = [];
    return;
  }
  timelineData.videoAssetList = Object.entries(videoAssetData).map(([key, refValue]) => {
    const raw = refValue?.value ?? refValue;

    let pathStr = '(No path)';
    if (Array.isArray(raw) && raw.length > 0) {
      const fullPath = raw[0]?.r?.path ?? '';
      const pathNoTail = fullPath.replace(/\.apx$/, '');
      pathStr = pathNoTail.replace(/^objects\/videoclip\//, '');
    }

    return { id: key, path: pathStr };
  });
}

/**
 * Computed layerReported — calco de CurrentVideoAssets.vue.
 * Combina layerNames y videoAssetList índice a índice.
 */
function computeLayerReported() {
  timelineData.layerReported = timelineData.layerNames.map((layer, i) => ({
    layer: layer.name,
    path: timelineData.videoAssetList[i]?.path || '(No path)',
  })).filter(item => item.layer !== '(Unnamed)' || item.path !== '(No path)');
}

// ---------------------------------------------------------------------------
// 7a. Compute track layers — calco de TrackDetail.vue
// ---------------------------------------------------------------------------

/**
 * Combina trackLayerData, layerVideoAssetData, layerStartTimeData, layerEndTimeData
 * en timelineData.trackLayers (estructura idéntica a TrackDetail.vue).
 */
function computeTrackLayers() {
  if (!trackLayerData || Object.keys(trackLayerData).length === 0) {
    timelineData.trackLayers = [];
    return;
  }

  const names = Object.entries(trackLayerData).map(([key, rawValue]) => {
    const name = typeof rawValue === 'string' ? rawValue
      : (rawValue?.name ?? '(Unnamed)');
    return { id: key, name: name.length > 0 ? name : '(Unnamed)' };
  });

  const assets = Object.entries(layerVideoAssetData).map(([key, refValue]) => {
    const raw = refValue?.value ?? refValue;
    let assetPath = '(No Asset)';
    if (Array.isArray(raw) && raw.length > 0) {
      const fullAssetPath = raw[0]?.r?.path ?? '';
      const pathNoApxTail = fullAssetPath.replace(/\.apx$/, '');
      assetPath = pathNoApxTail.replace(/^objects\/videoclip\//, '');
    }
    return { id: key, assetPath };
  });

  const startTimes = Object.entries(layerStartTimeData).map(([key, refValue]) => {
    const raw = refValue?.value ?? refValue;
    return { id: key, startTime: typeof raw === 'number' ? raw : 0 };
  });

  const endTimes = Object.entries(layerEndTimeData).map(([key, refValue]) => {
    const raw = refValue?.value ?? refValue;
    return { id: key, endTime: typeof raw === 'number' ? raw : 0 };
  });

  timelineData.trackLayers = names.map((tl, i) => ({
    trackLayer: tl.name,
    videoAsset: assets[i]?.assetPath || '(No Asset)',
    startTime: startTimes[i]?.startTime ?? 0,
    endTime: endTimes[i]?.endTime ?? 0,
  }));
}

/**
 * Subscribe to MonitoringManager and GuiSystem on connect/reconnect.
 * Backend needs both for status.json (metrics + timeline).
 * Frontend also subscribes directly to all metrics via its own WS connection.
 */
function resubscribeAll() {
  subscribeTimeline();
  subscribeLocalMetricsDetailed();
}

/**
 * Suscripciones fijas del timeline — calco de TrackDetail.vue.
 * Suscribe a activeLayers, tRender y track.layers.
 */
function subscribeTimeline() {
  // Exact SDK format: no id, configuration with updateFrequencyMs
  send({ subscribe: {
    object: 'GuiSystem.currentTransportManager',
    properties: [
      'object.player.tRender',
      'object.player.activeLayers',
      'object.track.layers',
      'object.track.description',
    ],
    configuration: { updateFrequencyMs: 100 },
  }});
}

/**
 * Reconexión con backoff exponencial.
 */
function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(2, Math.floor(Math.random() * 4)), 30000);
  console.log(`Reconectando en ${delay}ms ...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// ---------------------------------------------------------------------------
// 8. Métricas
// ---------------------------------------------------------------------------

function subscribeLocalMetricsDetailed() {
  const localSub = { configuration: { updateFrequencyMs: 1000 } };

  const subs = [
    { object: 'subsystem:MonitoringManager.findLocalMonitor("fps")', properties: ['object.seriesAverage("Actual", 1)', 'object.seriesAverage("Actual", 60)'] },
    { object: 'subsystem:MonitoringManager.findLocalMonitor("GPUProfiler")', properties: ['object.seriesAverage("Video Upload", 1)', 'object.seriesAverage("Capture Upload", 1)', 'object.seriesAverage("Compositor", 1)', 'object.seriesAverage("GUI", 1)', 'object.seriesAverage("Render Everything", 1)', 'object.seriesAverage("DMX", 1)', 'object.seriesAverage("Total", 1)'] },
    { object: 'subsystem:MonitoringManager.findLocalMonitor("CPU")', properties: ['object.seriesAverage("Total", 1)', 'object.seriesAverage("Renderer", 1)', 'object.seriesAverage("Core", 1)'] },
    { object: 'subsystem:MonitoringManager.findLocalMonitor("Machine")', properties: ['object.seriesAverage("CPU Time", 1)', 'object.seriesAverage("GPU Time", 1)', 'object.seriesAverage("CPU Memory", 1)', 'object.seriesAverage("GPU Memory", 1)', 'object.seriesAverage("Disk", 1)'] },
    { object: 'subsystem:MonitoringManager.findLocalMonitor("ProcessMemory")', properties: ['object.seriesAverage("Peak Usage (MB)", 1)', 'object.seriesAverage("Physical Memory (MB)", 1)', 'object.seriesAverage("Usage (MB)", 1)', 'object.seriesAverage("Working (MB)", 1)'] },
    { object: 'subsystem:MonitoringManager.findLocalMonitor("Disk")', properties: ['object.seriesAverage("Read (MB/s)", 1)', 'object.seriesAverage("Write (MB/s)", 1)'] },
  ];

  for (const { object: obj, properties } of subs) {
    const id = Math.floor(Math.random() * 1000000);
    send({ subscribe: { id, object: obj, properties, ...localSub } });
  }
}

/**
 * Suscribe a monitores remotos para un actor específico.
 */
function subscribeRemoteMetrics(hostname) {
  if (subscribedRemoteMonitors.has(hostname)) return;
  subscribedRemoteMonitors.add(hostname);
  const remoteSub = { configuration: { updateFrequencyMs: 1000 } };

  const subs = [
    { object: `subsystem:MonitoringManager.findRemoteMonitor("${hostname}", "fps")`, properties: ['object.seriesAverage("Actual", 1)', 'object.seriesAverage("Actual", 60)'] },
    { object: `subsystem:MonitoringManager.findRemoteMonitor("${hostname}", "GPUProfiler")`, properties: ['object.seriesAverage("Video Upload", 1)', 'object.seriesAverage("Capture Upload", 1)', 'object.seriesAverage("Compositor", 1)', 'object.seriesAverage("GUI", 1)', 'object.seriesAverage("Render Everything", 1)', 'object.seriesAverage("DMX", 1)', 'object.seriesAverage("Total", 1)'] },
    { object: `subsystem:MonitoringManager.findRemoteMonitor("${hostname}", "CPU")`, properties: ['object.seriesAverage("Total", 1)', 'object.seriesAverage("Renderer", 1)', 'object.seriesAverage("Core", 1)'] },
    { object: `subsystem:MonitoringManager.findRemoteMonitor("${hostname}", "Machine")`, properties: ['object.seriesAverage("CPU Time", 1)', 'object.seriesAverage("GPU Time", 1)', 'object.seriesAverage("CPU Memory", 1)', 'object.seriesAverage("GPU Memory", 1)', 'object.seriesAverage("Disk", 1)'] },
    { object: `subsystem:MonitoringManager.findRemoteMonitor("${hostname}", "ProcessMemory")`, properties: ['object.seriesAverage("Peak Usage (MB)", 1)', 'object.seriesAverage("Physical Memory (MB)", 1)', 'object.seriesAverage("Usage (MB)", 1)', 'object.seriesAverage("Working (MB)", 1)'] },
    { object: `subsystem:MonitoringManager.findRemoteMonitor("${hostname}", "Disk")`, properties: ['object.seriesAverage("Read (MB/s)", 1)', 'object.seriesAverage("Write (MB/s)", 1)'] },
  ];

  for (const { object: obj, properties } of subs) {
    send({ subscribe: { id: 'remote_' + hostname + '_' + Math.random().toString(36).substr(2, 8), object: obj, properties, ...remoteSub } });
  }
}

/**
 * Descubre actores vía REST y los suscribe a métricas remotas vía liveupdate.
 * Se llama una vez al conectar el WebSocket, no se hace polling.
 */
async function pollActorMetrics() {
  try {
    const data = await httpGetJson(DIRECTOR_HOST, DIRECTOR_PORT, '/api/session/status/health');
    if (!data?.result) return;
    for (const entry of data.result) {
      const hostname = entry.machine?.hostname;
      if (!hostname || hostname === directorHostname) continue;
      subscribeRemoteMetrics(hostname);
      if (!statusData.metrics.actors[hostname]) {
        statusData.metrics.actors[hostname] = {
          ts: '',
          fps: { actual: { value: 0, unit: 'fps' }, average: { value: 0, unit: 'fps' } },
          gpu: { videoUpload: { value: 0, unit: 'ms' }, captureUpload: { value: 0, unit: 'ms' }, compositor: { value: 0, unit: 'ms' }, gui: { value: 0, unit: 'ms' }, renderEverything: { value: 0, unit: 'ms' }, dmx: { value: 0, unit: 'ms' }, total: { value: 0, unit: 'ms' } },
          cpu: { total: { value: 0, unit: '%' }, renderer: { value: 0, unit: '%' }, core: { value: 0, unit: '%' } },
          machine: { cpuTime: { value: 0, unit: '%' }, gpuTime: { value: 0, unit: '%' }, cpuMemory: { value: 0, unit: 'MB' }, gpuMemory: { value: 0, unit: 'MB' }, disk: { value: 0, unit: 'MB/s' } },
          processMemory: { peakUsage: { value: 0, unit: 'MB' }, physicalMemory: { value: 0, unit: 'MB' }, usage: { value: 0, unit: 'MB' }, working: { value: 0, unit: 'MB' } },
          disk: { read: { value: 0, unit: 'MB/s' }, write: { value: 0, unit: 'MB/s' } },
        };
      }
      const s = entry.status;
      if (s) {
        const fps = s.averageFPS ?? 0;
        statusData.metrics.actors[hostname].fps.actual.value = fps;
        statusData.metrics.actors[hostname].fps.average.value = fps;
      }
    }
  } catch (err) {
    // Silently ignore — health endpoint may be temporarily unavailable
  }
}

// ---------------------------------------------------------------------------
// 9. Servidor HTTP (Express — estático + REST, sin proxy WebSocket)
// ---------------------------------------------------------------------------

const API_PORT = 3000;

function startHttpServer() {
  const app = express();
  app.use(express.json());

  // REST endpoints
  app.get('/api/status', (req, res) => {
    const raw = fs.readFileSync(STATUS_FILE);
    res.json(JSON.parse(raw));
  });

  app.get('/api/timeline', (req, res) => {
    res.json({
      playhead: timelineData.playhead,
      activeLayers: timelineData.layerReported,
      layerNames: timelineData.layerNames,
      videoAssetList: timelineData.videoAssetList,
      trackLayers: timelineData.trackLayers,
    });
  });

  app.get('/api/alerts', (req, res) => {
    res.json(alertConfig);
  });

  app.post('/api/alerts', (req, res) => {
    const body = req.body;
    // Merge: overlay frontend data onto server defaults
    for (const [key, val] of Object.entries(body)) {
      if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        // New structure: { defaults, actual }
        if ('actual' in val) {
          if (alertConfig[key]) {
            alertConfig[key].actual = { ...alertConfig[key].actual, ...val.actual };
          } else {
            alertConfig[key] = { defaults: { ...val.defaults }, actual: { ...val.actual } };
          }
        }
        // Legacy structure: flat { enabled, warning, critical, webhook }
        else {
          alertConfig[key] = { ...(alertConfig[key] || {}), ...val };
        }
      } else {
        alertConfig[key] = val;
      }
    }
    saveAlertConfig();
    res.json({ ok: true });
  });

  // POST /api/alerts/send — send a webhook alert via backend
  // This is the ONLY place webhooks are sent. Two guards prevent duplicates:
  //   1. Cooldown check (first): short-circuit if still in cooldown
  //   2. State transition: only send when metric just started alerting
  //   3. Cooldown: only send once per metric per 5min
  app.post('/api/alerts/send', (req, res) => {
    const { severity, metric, message, value, unit, threshold } = req.body || {};
    if (!message) return res.status(400).json({ error: 'missing "message" field' });

    if (!alertConfig.webhookEnabled || !alertConfig.webhookUrl) {
      return res.json({ ok: false, reason: 'webhook not enabled or URL not set' });
    }

    // Cooldown check — FIRST guard: short-circuit if still in cooldown
    const now = Date.now();
    if (metricLastTriggered[metric] && now - metricLastTriggered[metric] < METRIC_TRIGGER_COOLDOWN_MS) {
      return res.json({ ok: false, reason: 'cooldown active' });
    }

    // State transition guard: only send if metric is currently alerting
    if (!currentlyAlertingMetrics.has(metric)) {
      return res.json({ ok: false, reason: 'metric not alerting' });
    }

    // Ensure the metric is tracked in currentlyAlertingMetrics (persists across backend ticks)
    currentlyAlertingMetrics.add(metric);

    // Second cooldown check (value may have changed between checks)
    if (metricLastTriggered[metric] && now - metricLastTriggered[metric] < METRIC_TRIGGER_COOLDOWN_MS) {
      return res.json({ ok: false, reason: 'cooldown active' });
    }
    metricLastTriggered[metric] = now;

    const text = `🚨 Alert: ${message}`;
    const payload = { text };
    if (alertConfig.webhookUrl.includes('telegram.org')) {
      payload.chat_id = alertConfig.webhookChatId;
    }

    sendWebhook(alertConfig.webhookUrl, payload).then((ok) => {
      res.json({ ok });
    });
  });

  // ---------------------------------------------------------------------------
  // Playback: POST /api/play /api/stop /api/seek /api/play-section etc.
  // ---------------------------------------------------------------------------

  function transportForward(directorPath, reqBody) {
    return httpPostJson(DIRECTOR_HOST, DIRECTOR_PORT, directorPath, reqBody)
      .then((result) => {
        // Cache playing state from activetransport response
        if (directorPath === '/api/session/transport/play') {
          statusData.transport.playing = true;
          statusData.transport.isLooping = false;
        } else if (directorPath === '/api/session/transport/stop') {
          statusData.transport.playing = false;
          statusData.transport.isLooping = false;
        } else if (directorPath === '/api/session/transport/playloopsection') {
          statusData.transport.playing = true;
          statusData.transport.isLooping = true;
        }
        return result;
      });
  }

  app.post('/api/play', async (req, res) => {
    try {
      const result = await transportForward('/api/session/transport/play', { transports: [{ transport: {} }] });
      res.json(result);
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  app.post('/api/stop', async (req, res) => {
    try {
      const result = await transportForward('/api/session/transport/stop', { transports: [{ transport: {} }] });
      res.json(result);
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  app.post('/api/seek', async (req, res) => {
    try {
      const result = await transportForward('/api/session/transport/gototime', {
        transports: [{ transport: {}, time: req.body.time ?? 0 }],
      });
      res.json(result);
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  app.post('/api/play-section', async (req, res) => {
    try {
      const result = await transportForward('/api/session/transport/playsection', { transports: [{ transport: {} }] });
      res.json(result);
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  app.post('/api/loop-section', async (req, res) => {
    try {
      const result = await transportForward('/api/session/transport/playloopsection', { transports: [{ transport: {} }] });
      res.json(result);
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  app.post('/api/return-start', async (req, res) => {
    try {
      const result = await transportForward('/api/session/transport/returntostart', { transports: [{ transport: {} }] });
      res.json(result);
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  app.post('/api/next-section', async (req, res) => {
    try {
      const result = await transportForward('/api/session/transport/gotonextsection', { transports: [{ transport: {} }] });
      res.json(result);
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  app.post('/api/prev-section', async (req, res) => {
    try {
      const result = await transportForward('/api/session/transport/gotoprevsection', { transports: [{ transport: {} }] });
      res.json(result);
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  app.post('/api/next-track', async (req, res) => {
    try {
      const result = await transportForward('/api/session/transport/gotonexttrack', { transports: [{ transport: {} }] });
      res.json(result);
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  app.post('/api/prev-track', async (req, res) => {
    try {
      const result = await transportForward('/api/session/transport/gotoprevtrack', { transports: [{ transport: {} }] });
      res.json(result);
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  // GET transport status — caches playing state + returns full response
  app.get('/api/transport/status', async (req, res) => {
    try {
      const result = await httpGetJson(DIRECTOR_HOST, DIRECTOR_PORT, '/api/session/transport/activetransport');
      // Cache playing state
      if (result?.result?.activeTransports) {
        const active = result.result.activeTransports;
        statusData.transport.playing = active.some((t) => t.transport === 'play');
        statusData.transport.isLooping = active.some((t) => t.transport === 'playloopsection');
      }
      res.json(result);
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  // ---------------------------------------------------------------------------
  // Legacy routes — backward compat for frontend (TransportButtons.vue, TransportControls.vue, Timeline.vue)
  // ---------------------------------------------------------------------------

  // GET /api/transport/activetransport — old format { result: [ ... ] }
  app.get('/api/transport/activetransport', async (req, res) => {
    try {
      const result = await httpGetJson(DIRECTOR_HOST, DIRECTOR_PORT, '/api/session/transport/activetransport');
      // Transform { result: { activeTransports: [...] } } → { result: [...] }
      if (result?.result?.activeTransports) {
        res.json({ result: result.result.activeTransports });
      } else {
        res.json(result);
      }
      // Also cache playing state
      if (result?.result?.activeTransports) {
        const active = result.result.activeTransports;
        statusData.transport.playing = active.some((t) => t.transport === 'play');
        statusData.transport.isLooping = active.some((t) => t.transport === 'playloopsection');
      }
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  // POST /api/transport/* — forward old route names to new Director paths
  const legacyTransportMap = {
    play:            '/api/session/transport/play',
    stop:            '/api/session/transport/stop',
    playsection:     '/api/session/transport/playsection',
    playloopsection: '/api/session/transport/playloopsection',
    returntostart:   '/api/session/transport/returntostart',
    gotonextsection: '/api/session/transport/gotonextsection',
    gotoprevsection: '/api/session/transport/gotoprevsection',
    gotonexttrack:   '/api/session/transport/gotonexttrack',
    gotoprevtrack:   '/api/session/transport/gotoprevtrack',
    gototime:        null, // handled separately below
  };

  for (const [name, directorPath] of Object.entries(legacyTransportMap)) {
    if (directorPath === null) continue;
    app.post(`/api/transport/${name}`, async (req, res) => {
      try {
        const result = await transportForward(directorPath, { transports: [{ transport: {} }] });
        res.json(result);
      } catch (err) { res.status(502).json({ error: err.message }); }
    });
  }

  // POST /api/transport/gototime — special case with time param
  app.post('/api/transport/gototime', async (req, res) => {
    try {
      const result = await transportForward('/api/session/transport/gototime', {
        transports: [{ transport: {}, time: req.body.time ?? 0 }],
      });
      res.json(result);
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  // GET /api/health — simplified health summary (no metrics, no timeline)
  app.get('/api/health', (req, res) => {
    const summary = {};
    for (const [host, info] of Object.entries(statusData.health || {})) {
      summary[host] = {
        status: info.status,
        averageFPS: info.averageFPS ?? 0,
        states: info.states?.map((s) => ({ category: s.category, severity: s.severity, name: s.name })) || [],
      };
    }
    res.json(summary);
  });

  // GET /api/timeline/active — active layers only (no trackLayers)
  app.get('/api/timeline/active', (req, res) => {
    res.json({
      playhead: formatTimecode(timelineData.playhead),
      playing: statusData.transport.playing,
      activeLayers: timelineData.layerReported,
    });
  });

  // GET /api/timeline/sections — track layers / sections with timing
  app.get('/api/timeline/sections', (req, res) => {
    res.json({
      playhead: formatTimecode(timelineData.playhead),
      playing: statusData.transport.playing,
      isLooping: statusData.transport.isLooping,
      activeLayers: timelineData.layerReported,
      trackLayers: timelineData.trackLayers.map((tl) => ({
        ...tl,
        startTime: formatTimecode(tl.startTime),
        endTime: formatTimecode(tl.endTime),
      })),
    });
  });

  // GET /api/alerts/config — alias for /api/alerts
  app.get('/api/alerts/config', (req, res) => {
    res.json(alertConfig);
  });

  // POST /api/alerts/modify — change single metric threshold
  app.post('/api/alerts/modify', (req, res) => {
    const { metric, ...fields } = req.body;
    if (!metric || !alertConfig[metric]) {
      return res.status(400).json({ error: `Invalid metric. Available: ${Object.keys(DEFAULT_ALERT_DEFS).join(', ')}` });
    }
    if (!alertConfig[metric].actual) alertConfig[metric].actual = { ...DEFAULT_ALERT_DEFS[metric] };
    for (const [key, val] of Object.entries(fields)) {
      alertConfig[metric].actual[key] = val;
    }
    saveAlertConfig();
    res.json({ ok: true, metric, updated: fields });
  });

  // POST /api/alerts/webhook — configure Telegram
  app.post('/api/alerts/webhook', (req, res) => {
    const { url, chatId, enabled } = req.body;
    if (typeof url === 'string') alertConfig.webhookUrl = url;
    if (typeof chatId === 'string') alertConfig.webhookChatId = chatId;
    if (typeof enabled === 'boolean') alertConfig.webhookEnabled = enabled;
    saveAlertConfig();
    res.json({ ok: true });
  });

  // POST /api/alerts/webhook/toggle — toggle global webhook on/off
  app.post('/api/alerts/webhook/toggle', (req, res) => {
    alertConfig.webhookEnabled = !alertConfig.webhookEnabled;
    saveAlertConfig();
    res.json({ ok: true, webhookEnabled: alertConfig.webhookEnabled });
  });

  // POST /api/alerts/reset — reset all alert thresholds to defaults
  app.post('/api/alerts/reset', (req, res) => {
    for (const [key, cfg] of Object.entries(alertConfig)) {
      if (!(key in DEFAULT_ALERT_DEFS)) continue;
      cfg.actual = { ...DEFAULT_ALERT_DEFS[key] };
    }
    saveAlertConfig();
    res.json({ ok: true });
  });

  app.get('/api/actors', (req, res) => {
    const actors = [];
    const directorHost = directorHostname;
    for (const [host, m] of Object.entries(statusData.metrics?.actors || {})) {
      if (host === directorHost) continue;
      actors.push({
        hostname: host,
        metrics: {
          fps: { actual: m.fps?.actual?.value ?? 0, average: m.fps?.average?.value ?? 0 },
          gpu: {
            videoUpload: m.gpu?.videoUpload?.value ?? 0,
            captureUpload: m.gpu?.captureUpload?.value ?? 0,
            compositor: m.gpu?.compositor?.value ?? 0,
            gui: m.gpu?.gui?.value ?? 0,
            renderEverything: m.gpu?.renderEverything?.value ?? 0,
            dmx: m.gpu?.dmx?.value ?? 0,
            total: m.gpu?.total?.value ?? 0,
          },
          cpu: {
            total: m.cpu?.total?.value ?? 0,
            renderer: m.cpu?.renderer?.value ?? 0,
            core: m.cpu?.core?.value ?? 0,
          },
          machine: {
            cpuTime: m.machine?.cpuTime?.value ?? 0,
            gpuTime: m.machine?.gpuTime?.value ?? 0,
            cpuMemory: m.machine?.cpuMemory?.value ?? 0,
            gpuMemory: m.machine?.gpuMemory?.value ?? 0,
            disk: m.machine?.disk?.value ?? 0,
          },
          processMemory: {
            peakUsage: m.processMemory?.peakUsage?.value ?? 0,
            physicalMemory: m.processMemory?.physicalMemory?.value ?? 0,
            usage: m.processMemory?.usage?.value ?? 0,
            working: m.processMemory?.working?.value ?? 0,
          },
          disk: { read: m.disk?.read?.value ?? 0, write: m.disk?.write?.value ?? 0 },
        },
      });
    }
    res.json(actors);
  });

  // GET /api/summary — compact view for OpenClaw
  const ALERT_METRIC_PATHS = {
    'FPS Actual': ['fps', 'actual'],
    'GPU Load': ['gpu', 'total'],
    'GPU Compositor': ['gpu', 'compositor'],
    'GPU GUI': ['gpu', 'gui'],
    'GPU Render Everything': ['gpu', 'renderEverything'],
    'CPU Time': ['machine', 'cpuTime'],
    'GPU Time': ['machine', 'gpuTime'],
    'Process Memory Usage': ['processMemory', 'usage'],
    'GPU Memory': ['machine', 'gpuMemory'],
    'Disk Read': ['disk', 'read'],
    'Disk Write': ['disk', 'write'],
  };

  function resolveMetricValue(metricName) {
    const path = ALERT_METRIC_PATHS[metricName];
    if (!path) return undefined;
    const dir = statusData.metrics.director;
    if (!dir) return undefined;
    let obj = dir;
    for (const seg of path) {
      if (obj == null) return undefined;
      obj = obj[seg];
    }
    return obj?.value;
  }

  function computeActiveAlerts() {
    let count = 0;
    for (const [key, cfg] of Object.entries(alertConfig)) {
      if (!(key in DEFAULT_ALERT_DEFS)) continue;
      const actual = cfg.actual || cfg;
      if (!actual.enabled) continue;
      const val = resolveMetricValue(key);
      if (val == null) continue;
      const isLowerWorse = key === 'FPS Actual';
      const meetsCritical = isLowerWorse ? (val <= actual.critical) : (val >= actual.critical);
      const meetsWarning = isLowerWorse ? (val <= actual.warning) : (val >= actual.warning);
      if (meetsCritical || meetsWarning) count++;
    }
    return count;
  }

  app.get('/api/summary', (req, res) => {
    const directorHealth = (statusData.health?.director || {}).status;
    const directorFps = statusData.metrics.director.fps?.actual?.value ?? 0;
    const directorOk = (directorHealth === 'healthy') || (directorFps > 0);
    const activeLayers = timelineData.layerReported?.length ?? 0;
    const activeAlerts = computeActiveAlerts();
    res.json({
      system: directorOk ? 'OK' : 'DEGRADED',
      director: {
        status: directorOk ? 'OK' : 'DEGRADED',
        fps: directorFps,
      },
      timeline: {
        playing: statusData.transport.playing,
        isLooping: statusData.transport.isLooping,
        playhead: formatTimecode(timelineData.playhead),
        activeLayers: activeLayers,
      },
      alerts: activeAlerts,
    });
  });

  // Servir frontend estático (fallback a index.html para SPA)
  const distDir = path.join(__dirname, '..', 'frontend', 'dist');
  app.use(express.static(distDir));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });

  // Servir Pulse metrics como ruta separada
  const pulseDir = path.join(__dirname, '..', 'frontend', 'public', 'pulse');
  app.use('/metrics', express.static(pulseDir));
  app.get('/metrics', (req, res) => {
    res.sendFile(path.join(pulseDir, 'index.html'));
  });

  httpServer = require('http').createServer(app);

  httpServer.listen(API_PORT, '0.0.0.0', () => {
    console.log(`API disponible en http://0.0.0.0:${API_PORT}`);
  });
}

// ---------------------------------------------------------------------------
// 10. Inicio
// ---------------------------------------------------------------------------

async function main() {
  console.log('D3Reporter WebSocket Service');
  console.log(`Estado: ${STATUS_FILE}`);
  console.log('---');

  loadAlertConfig();

  // Start HTTP server first so frontend can load static files before backend subscribes
  startHttpServer();

  connect();

  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) { clearInterval(check); resolve(); }
    }, 200);
    setTimeout(() => { clearInterval(check); resolve(); }, 10000);
  });

  console.log('Listo. Ctrl+C para detener.');
}

function cleanup() {
  console.log('Apagando...');
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) ws.close();
  if (httpServer) httpServer.close();
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

main().catch((err) => {
  console.error(`Error al iniciar: ${err.message}`);
  process.exit(1);
});
