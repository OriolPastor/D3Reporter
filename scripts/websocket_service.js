// websocket_service.js
// Servicio: conecta con el Director de Disguise vía WebSocket,
// suscribe métricas y timeline, escribe status.json unificado (salud + timeline).
//
// Frontend: se conecta directamente al Director (no hay proxy WebSocket).
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
const INTERVAL_STATUS = 2000;

// ---------------------------------------------------------------------------
// 3. Estado global
// ---------------------------------------------------------------------------
let ws = null;
let subscriptions = [];
let liveMetrics = {};
let statusData = { servers: [] };

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
let reconnectTimer = null;
let statusTimer = null;
let startTime = Date.now();

// ---------------------------------------------------------------------------
// 4. Utilidades HTTP
// ---------------------------------------------------------------------------

function httpGetJson(host, port, urlPath) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const req = http.request(
      { hostname: host, port: port, path: urlPath, method: 'GET', timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`JSON inválido: ${body}`)); }
        });
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
    console.error(`Error session status: ${err.message}`);
    return { director: null, actors: [] };
  }
}

async function fetchHealthStatus() {
  try {
    const data = await httpGetJson(DIRECTOR_HOST, DIRECTOR_PORT, '/api/session/status/health');
    if (!data?.result) return {};
    const map = {};
    for (const entry of data.result) {
      if (entry.machine?.hostname) map[entry.machine.hostname] = entry.status;
    }
    return map;
  } catch (err) {
    console.error(`Error health status: ${err.message}`);
    return {};
  }
}

// ---------------------------------------------------------------------------
// 5. status.json
// ---------------------------------------------------------------------------

function buildStatusData() {
  statusData.servers = [];
  statusData.websocketState = ws ? (ws.readyState === WebSocket.OPEN ? 'connected' : 'disconnected') : 'disconnected';

  if (statusData._directorHostname) {
    const health = statusData._healthMap?.[statusData._directorHostname] || {};
    const metric = liveMetrics[statusData._directorHostname] || {};
    statusData.servers.push({
      type: 'director',
      hostname: statusData._directorHostname,
      averageFPS: metric.fps || health.averageFPS || 0,
      states: (health.states || []).map((s) => ({
        category: s.category, severity: s.severity, name: s.name, detail: s.detail,
      })),
    });
  }

  for (const [host, health] of Object.entries(statusData._healthMap || {})) {
    if (host === statusData._directorHostname) continue;
    const metric = liveMetrics[host] || {};
    statusData.servers.push({
      type: 'actor',
      hostname: host,
      averageFPS: metric.fps || health.averageFPS || 0,
      states: (health.states || []).map((s) => ({
        category: s.category, severity: s.severity, name: s.name, detail: s.detail,
      })),
    });
  }

  // Timeline section — playhead, active layers, track layers
  statusData.timeline = {
    playhead: timelineData.playhead,
    activeLayers: timelineData.layerReported.map((item) => ({
      name: item.layer,
      asset: item.path,
    })),
    trackLayers: timelineData.trackLayers.map((tl) => ({
      name: tl.trackLayer ?? tl.name ?? '(Unnamed)',
      asset: tl.videoAsset ?? tl.asset ?? '(No asset)',
      start: tl.startTime ?? tl.start ?? 0,
      end: tl.endTime ?? tl.end ?? 0,
      duration: tl.duration ?? (tl.endTime ?? tl.end ?? 0) - (tl.startTime ?? tl.start ?? 0),
    })),
  };

  fs.writeFileSync(STATUS_FILE, JSON.stringify(statusData, null, 2));
}

async function updateStatusFromHealth() {
  const session = await fetchSessionStatus();
  const healthMap = await fetchHealthStatus();

  const directorHost = session.director?.hostname || DIRECTOR_HOST;
  statusData._directorHostname = directorHost;
  statusData._healthMap = healthMap;

  if (directorHost) {
    console.log(`Director: ${directorHost}`);
  } else {
    console.log('Sin servidores (¿hay sesión activa?)');
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

  ws.on('open', () => {
    console.log('WebSocket abierto.');
    startTime = Date.now();
    dynamicSubscriptionsSent = false;
    layerData = {};
    videoAssetData = {};
    timelineData.layerReported = [];
    timelineData.trackLayers = [];
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
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/**
 * Mapea subscription id → propertyPath para resolver valuesChanged.
 */
function buildIdMap() {
  const map = {};
  for (const sub of subscriptions) {
    map[sub.id] = sub.propertyPath;
  }
  return map;
}

function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); }
  catch (e) { console.error(`Mensaje inválido: ${raw}`); return; }

  if (msg.error) { console.error(`Error del servidor: ${JSON.stringify(msg.error)}`); return; }

  // Confirmación de suscripciones — merge, no overwrite.
  if (msg.subscriptions) {
    const newSubs = msg.subscriptions.map((s) => ({
      id: s.id, objectPath: s.objectPath, propertyPath: s.propertyPath,
    }));
    const existingIds = new Set(subscriptions.map((s) => s.id));
    for (const sub of newSubs) {
      if (!existingIds.has(sub.id)) {
        subscriptions.push(sub);
      }
    }
    return;
  }

  // Valores actualizados
  if (msg.valuesChanged) {
    const idMap = buildIdMap();
    const changes = msg.valuesChanged;

    // Separar timeline (GuiSystem) de métricas (MonitoringManager)
    // Se usa sub.objectPath (no propertyPath) porque 'subsystem:' está en objectPath.
    const timelineChanges = [];
    const metricChanges = [];
    for (const change of changes) {
      let sub = subscriptions.find((s) => s.id === change.id);
      let prop = idMap[change.id] || 'unknown';

      // Fallback: si no se encuentra por id, intentar por propertyPath
      if (!sub) {
        sub = subscriptions.find((s) => s.propertyPath === change.propertyPath);
        prop = sub?.propertyPath || 'unknown';
      }

      if (sub && sub.objectPath.includes('GuiSystem')) {
        timelineChanges.push({ ...change, _propPath: prop });
      } else {
        metricChanges.push(change);
      }
    }
    if (timelineChanges.length > 0) {
      handleTimelineChanges(timelineChanges);
    }
    if (metricChanges.length > 0) {
      handleValuesChanged(metricChanges);
    }
  }
}

/**
 * Procesa cambios de métricas y los almacena en liveMetrics.
 */
function handleValuesChanged(changes) {
  for (const change of changes) {
    const sub = subscriptions.find((s) => s.id === change.id);
    if (!sub) { continue; }

    const key = `${sub.objectPath}/${sub.propertyPath}`;
    const metricName = key.includes('"') ? key.match(/"([^"]+)"/)?.[1] || 'unknown' : 'unknown';

    if (key.startsWith('subsystem:MonitoringManager.findLocalMonitor')) {
      if (!liveMetrics[DIRECTOR_HOST]) liveMetrics[DIRECTOR_HOST] = {};
      liveMetrics[DIRECTOR_HOST].fps = change.value;
    } else if (key.startsWith('subsystem:MonitoringManager.findRemoteMonitor')) {
      const hostname = key.match(/findRemoteMonitor\("([^"]+)"/)?.[1] || 'unknown';
      if (!liveMetrics[hostname]) liveMetrics[hostname] = {};
      liveMetrics[hostname].fps = change.value;
    }
  }
  buildStatusData();
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
  const idMap = buildIdMap();

  for (const change of changes) {
    const prop = idMap[change.id] || 'unknown';

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
  }));
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
    return { id: key, startTime: typeof raw === 'number' ? raw.toFixed(2) : 0 };
  });

  const endTimes = Object.entries(layerEndTimeData).map(([key, refValue]) => {
    const raw = refValue?.value ?? refValue;
    return { id: key, endTime: typeof raw === 'number' ? raw.toFixed(2) : 0 };
  });

  timelineData.trackLayers = names.map((tl, i) => ({
    trackLayer: tl.name,
    videoAsset: assets[i]?.assetPath || '(No Asset)',
    startTime: startTimes[i]?.startTime ?? 0,
    endTime: endTimes[i]?.endTime ?? 0,
  }));
}

/**
 * Reenvía todas las suscripciones tras reconexión.
 */
function resubscribeAll() {
  const grouped = {};
  for (const sub of subscriptions) {
    if (!grouped[sub.objectPath]) grouped[sub.objectPath] = [];
    grouped[sub.objectPath].push(sub.propertyPath);
  }
  for (const [objectPath, properties] of Object.entries(grouped)) {
    send({ subscribe: { object: objectPath, properties } });
  }
  subscribeTimeline();
}

/**
 * Suscripciones fijas del timeline — calco de TrackDetail.vue.
 * Suscribe a activeLayers, tRender y track.layers.
 */
function subscribeTimeline() {
  send({ subscribe: {
    object: 'GuiSystem.currentTransportManager',
    properties: [
      'object.player.tRender',
      'object.player.activeLayers',
      'object.track.layers',
      'object.track.description',
    ],
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

function subscribeLocalMetrics() {
  send({ subscribe: {
    object: 'subsystem:MonitoringManager.findLocalMonitor("fps")',
    properties: ['object.seriesAverage("Actual", 1)'],
  }});
}

async function subscribeRemoteMetrics() {
  const session = await fetchSessionStatus();
  if (session.actors?.length === 0) return;
  for (const actor of session.actors) {
    if (!actor.hostname) continue;
    if (actor.hostname === session.director?.hostname) continue;

    send({ subscribe: {
      object: `subsystem:MonitoringManager.findRemoteMonitor("${actor.hostname}", "fps")`,
      properties: ['object.seriesAverage("Actual", 1)'],
    }});
    console.log(`Suscrito a: ${actor.hostname}`);
  }
}

// ---------------------------------------------------------------------------
// 9. Servidor HTTP (Express — estático + REST, sin proxy WebSocket)
// ---------------------------------------------------------------------------

const API_PORT = 3000;

function startHttpServer() {
  const app = express();

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

  // Servir frontend estático (fallback a index.html para SPA)
  const distDir = path.join(__dirname, '..', 'frontend', 'dist');
  app.use(express.static(distDir));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });

  app.listen(API_PORT, '0.0.0.0', () => {
    console.log(`Frontend + API disponible en http://0.0.0.0:${API_PORT}`);
    console.log(`  /api/status  — status.json`);
    console.log(`  /api/timeline — timeline data`);
  });
}

// ---------------------------------------------------------------------------
// 10. Inicio
// ---------------------------------------------------------------------------

async function main() {
  console.log('D3Reporter WebSocket Service');
  console.log(`Estado: ${STATUS_FILE}`);
  console.log('---');

  await updateStatusFromHealth();
  connect();

  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) { clearInterval(check); resolve(); }
    }, 200);
    setTimeout(() => { clearInterval(check); resolve(); }, 10000);
  });

  subscribeLocalMetrics();
  await subscribeRemoteMetrics();

  statusTimer = setInterval(updateStatusFromHealth, INTERVAL_STATUS);

  // Servidor HTTP (Express — estático + REST, sin proxy WebSocket)
  startHttpServer();

  console.log('Listo. Ctrl+C para detener.');
}

function cleanup() {
  console.log('Apagando...');
  if (statusTimer) clearInterval(statusTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) ws.close();
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

main().catch((err) => {
  console.error(`Error al iniciar: ${err.message}`);
  process.exit(1);
});
