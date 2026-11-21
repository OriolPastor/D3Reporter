<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import TransportControls from './TransportControls.vue';
import { usePlayhead } from '../composables/usePlayhead';

const props = defineProps({
    liveUpdate: { type: Object, required: true }
});

// --- LiveUpdate subscriptions ---
const playhead = usePlayhead();

const { currentTrackName } = props.liveUpdate.subscribe('GuiSystem.currentTransportManager', {
    currentTrackName: 'object.track.description'
});

// Active layers — needed to have our own subscription IDs so
// `valuesChanged` messages are mappable on this connection
const { activeLayers } = props.liveUpdate.subscribe('GuiSystem.currentTransportManager', {
    activeLayers: 'object.player.activeLayers'
});

// Layer names
const { trackLayerArray } = props.liveUpdate.subscribe('GuiSystem.currentTransportManager', {
    trackLayerArray: 'object.track.layers'
});
const layerCount = computed(() => Array.isArray(trackLayerArray.value) ? trackLayerArray.value.length : 0);

const trackLayerData = ref({});
watch(
    () => layerCount.value,
    (count) => {
        if (!count) return;
        const sub = {};
        for (let i = 0; i < count; i++) sub[`layer${i}`] = `object.track.layers[${i}].name`;
        trackLayerData.value = props.liveUpdate.subscribe('GuiSystem.currentTransportManager', sub);
    }
);

const layerNames = computed(() => {
    if (!trackLayerData.value) return [];
    return Object.entries(trackLayerData.value).map(([k, v]) => ({
        name: typeof v === 'string' && v.length > 0 ? v : '(Unnamed)',
    }));
});

// Layer start times
const layerStartData = ref({});
watch(
    () => layerCount.value,
    (count) => {
        if (!count) return;
        const sub = {};
        for (let i = 0; i < count; i++) sub[`s${i}`] = `object.track.layers[${i}].tStart`;
        layerStartData.value = props.liveUpdate.subscribe('GuiSystem.currentTransportManager', sub);
    }
);

const layerStarts = computed(() => {
    if (!layerStartData.value) return [];
    return Object.entries(layerStartData.value).map(([k, v]) => {
        const raw = v?.value ?? v;
        return typeof raw === 'number' ? raw : 0;
    });
});

// Layer end times
const layerEndData = ref({});
watch(
    () => layerCount.value,
    (count) => {
        if (!count) return;
        const sub = {};
        for (let i = 0; i < count; i++) sub[`e${i}`] = `object.track.layers[${i}].tEnd`;
        layerEndData.value = props.liveUpdate.subscribe('GuiSystem.currentTransportManager', sub);
    }
);

const layerEnds = computed(() => {
    if (!layerEndData.value) return [];
    return Object.entries(layerEndData.value).map(([k, v]) => {
        const raw = v?.value ?? v;
        return typeof raw === 'number' ? raw : 0;
    });
});

// --- Combined track data (preserves original Disguise layer order) ---
const tracksRaw = computed(() => {
    return layerNames.value.map((tl, i) => ({
        name: tl.name,
        start: layerStarts.value[i] ?? 0,
        end: layerEnds.value[i] ?? 0,
        duration: (layerEnds.value[i] ?? 0) - (layerStarts.value[i] ?? 0),
        origIndex: i,
    }));
});

// Sort tracks by start time for timeline range / active-layer queries
const tracks = computed(() => {
    return [...tracksRaw.value].sort((a, b) => a.start - b.start || a.origIndex - b.origIndex);
});

// Timeline range
const timelineEnd = computed(() => {
    if (tracks.value.length === 0) return 60;
    return Math.max(...tracks.value.map(t => t.end), 60);
});

// --- Dynamic segments: each layer split at every boundary, level computed dynamically ---
// Collect all unique time boundaries from layer start/end points
const timelineBoundaries = computed(() => {
    const set = new Set();
    for (const t of tracksRaw.value) {
        set.add(t.start);
        set.add(t.end);
    }
    return Array.from(set).sort((a, b) => a - b);
});

const segments = computed(() => {
    const boundaries = timelineBoundaries.value;
    if (boundaries.length < 2 || tracksRaw.value.length === 0) return [];

    const allSegs = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
        const segStart = boundaries[i];
        const segEnd = boundaries[i + 1];
        const segMid = (segStart + segEnd) / 2;

        const active = tracksRaw.value.filter(
            t => segMid >= t.start && segMid < t.end
        );
        if (active.length === 0) continue;

        active.sort((a, b) => a.origIndex - b.origIndex);

        active.forEach((t, idx) => {
            allSegs.push({
                start: segStart,
                end: segEnd,
                layer: t.name,
                origIndex: t.origIndex,
                segActiveCount: active.length,
                idx,
            });
        });
    }

    // Stack from floor upward: first layer (lowest origIndex) = above floor,
    // subsequent layers go up to floor. Non-overlapping layers go to floor.
    const globalMaxTier = Math.max(...allSegs.map((s) => s.segActiveCount), 1) - 1;
    allSegs.forEach((s) => {
        s.visualTier = globalMaxTier - s.segActiveCount + 1 + s.idx;
    });

    return allSegs;
});

// Max visual tier for row height
const maxTier = computed(() => {
    if (segments.value.length === 0) return 1;
    return Math.max(...segments.value.map((s) => s.visualTier), 0);
});

// Active layer names (uses sorted tracks for time-range queries)
const activeTrackNames = computed(() => {
    const ph = playhead.value.value ?? 0;
    return tracks.value.filter(t => ph >= t.start && ph < t.end).map(t => t.name);
});

// Zoom levels (seconds per 100px of track width)
const zoomLevels = [600, 300, 120, 60, 30, 10, 3];
const zoomIndex = ref(5);
const pixelsPerSecond = computed(() => {
    const base = 100;
    const secs = zoomLevels[zoomIndex.value] ?? 60;
    return base / secs;
});
const timelineWidth = computed(() => timelineEnd.value * pixelsPerSecond.value);

function zoomIn() { zoomIndex.value = Math.min(zoomIndex.value + 1, zoomLevels.length - 1); }
function zoomOut() { zoomIndex.value = Math.max(zoomIndex.value - 1, 0); }
// Playhead position
const playheadX = computed(() => (playhead.value.value ?? 0) * pixelsPerSecond.value);
const playheadTime = computed(() => formatTimecode(playhead.value.value ?? 0));

// --- Track row: track name + all active layers + next layer ---
const activeLayerInfo = computed(() => {
    const ph = playhead.value.value ?? 0;
    const active = tracks.value.filter(t => ph >= t.start && ph < t.end);
    return active.map(t => ({
        name: t.name,
        time: '-' + formatTimecode(t.end - ph), // remaining time
    }));
});

const nextLayerInfo = computed(() => {
    const ph = playhead.value.value ?? 0;
    const next = tracks.value.find(t => t.start > ph);
    if (!next) return { isEnd: true, time: '-' + formatTimecode(timelineEnd.value - ph) };
    const diff = next.start - ph;
    return { name: next.name, time: '-' + formatTimecode(diff) };
});

// --- Tick marks ---
function getLabelInterval() {
    return zoomLevels[zoomIndex.value] ?? 60;
}

function generateTicks() {
    const pps = pixelsPerSecond.value;
    const totalSecs = timelineEnd.value;
    const labelInterval = getLabelInterval();
    const ticks = [];
    for (let s = 0; s <= totalSecs; s++) {
        const isLabel = s % labelInterval === 0 || s === 0;
        ticks.push({ sec: s, x: s * pps, isLabel });
    }
    return ticks;
}

const ticks = computed(() => generateTicks());

// --- Viewport tracking for scroll ---
const viewportWidth = ref(800);
const scrollContainer = ref(null);
let resizeObserver = null;

async function onTimelineClick(e) {
    const el = scrollContainer.value;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const offsetX = e.clientX - rect.left + el.scrollLeft;
    if (offsetX < 0 || offsetX > rect.width) return;
    const clickedTime = offsetX / pixelsPerSecond.value;
    const targetTime = Math.max(0, clickedTime);
    // Seek via backend API (avoids overwriting the LiveUpdate Ref which breaks the connection)
    try {
        await fetch('/api/transport/gototime', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ time: targetTime })
        });
    } catch (err) {
        // console.error('Timeline seek failed:', err);
    }
    // Scroll viewport to follow
    const px = clickedTime * pixelsPerSecond.value;
    el.scrollLeft = Math.max(0, px - viewportWidth.value / 2);
}

onMounted(() => {
    // Create the playhead subscription NOW — before any computed evaluation
    playhead.subscribe(props.liveUpdate);

    if (scrollContainer.value) {
        const el = scrollContainer.value;
        viewportWidth.value = el.clientWidth;
        resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                viewportWidth.value = entry.contentRect.width;
            }
        });
        resizeObserver.observe(el);
    }

    // Re-create dynamic subscriptions with fresh IDs
    const count = layerCount.value;
    if (count > 0) {
        const nameSubs = {};
        const startSubs = {};
        const endSubs = {};
        for (let i = 0; i < count; i++) {
            nameSubs[`layer${i}`] = `object.track.layers[${i}].name`;
            startSubs[`s${i}`] = `object.track.layers[${i}].tStart`;
            endSubs[`e${i}`] = `object.track.layers[${i}].tEnd`;
        }
        trackLayerData.value = props.liveUpdate.subscribe('GuiSystem.currentTransportManager', nameSubs);
        layerStartData.value = props.liveUpdate.subscribe('GuiSystem.currentTransportManager', startSubs);
        layerEndData.value = props.liveUpdate.subscribe('GuiSystem.currentTransportManager', endSubs);
    }
});

onUnmounted(() => {
    if (resizeObserver) resizeObserver.disconnect();
});

// --- Time formatting ---
function formatTimecode(seconds) {
    if (typeof seconds !== 'number' || isNaN(seconds)) return '00:00:00:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const fps = 60;
    const frame = Math.floor(((seconds % 1) * fps) % fps);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(frame).padStart(2, '0')}`;
}

function formatTimecodeShort(seconds) {
    if (typeof seconds !== 'number' || isNaN(seconds)) return '00:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
</script>

<template>
    <div class="timeline-panel">
        <!-- Transport controls -->
        <div class="transport-wrapper">
            <TransportControls :liveUpdate="liveUpdate" />
        </div>

        <!-- Track row: track name + pattern layers + next layer -->
        <div class="track-row">
            <span class="track-label">{{ currentTrackName || '—' }}</span>
            <template v-for="al in activeLayerInfo" :key="al.name">
                <span class="track-name active">{{ al.name }} {{ al.time }}</span>
            </template>
            <span v-if="nextLayerInfo" class="track-sep">|</span>
            <span v-if="nextLayerInfo.isEnd" class="track-name end">END {{ nextLayerInfo.time }}</span>
            <span v-else-if="nextLayerInfo.name" class="track-name next">{{ nextLayerInfo.name }} {{ nextLayerInfo.time }}</span>
        </div>

        <!-- Zoom controls below track row -->
        <div class="zoom-bar">
            <div class="timeline-controls">
                <button class="zoom-btn" @click="zoomOut" title="Zoom out">&#8722;</button>
                 <button class="zoom-btn" @click="zoomIn" title="Zoom in">+</button>
            </div>
        </div>

        <!-- Scrollable timeline area -->
        <div ref="scrollContainer" class="timeline-scroll" @click="onTimelineClick">
            <div class="timeline-canvas" :style="{ width: timelineWidth + 'px' }">

                <!-- Dynamic segments: each layer as individual bar, positioned by level, z-index by origIndex -->
               <div class="layer-row" :style="{ height: (maxTier + 1) * 32 + 'px' }">
                    <div
                        v-for="(seg, i) in segments"
                        :key="i"
                        class="layer-bar"
                        :class="{ 'layer-active': activeTrackNames.includes(seg.layer) }"
                        :style="{
                            position: 'absolute',
                            left: timelineEnd > 0 ? (seg.start / timelineEnd) * 100 + '%' : '0%',
                            width: timelineEnd > 0 ? Math.max(((seg.end - seg.start) / timelineEnd) * 100, 0.5) + '%' : '0%',
                            top: seg.visualTier * 32 + 'px',
                            height: '28px',
                            zIndex: seg.visualTier,
                        }"
                        :title="`${seg.layer} | ${formatTimecode(seg.start)} – ${formatTimecode(seg.end)}`"
                    >
                        <span class="layer-label">
                            {{ seg.layer }}
                        </span>
                    </div>
                </div>

                <!-- Tick marks (below layer bars) -->
                <div class="tick-row">
                    <div v-for="tick in ticks" :key="tick.sec" class="tick" :class="{ 'tick-label': tick.isLabel }" :style="{ left: tick.x + 'px' }">
                        <span class="tick-label">{{ tick.isLabel ? formatTimecode(tick.sec) : '' }}</span>
                    </div>
                </div>

                <!-- Playhead line -->
                <div class="playhead-line" :style="{ left: playheadX + 'px' }">
                    <div class="playhead-marker"></div>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.timeline-panel {
    width: 100%;
    margin: 0;
    font-family: 'Segoe UI', Inter, system-ui, sans-serif;
}

.timeline-controls {
    display: flex;
    align-items: center;
    gap: 0.4rem;
}

.zoom-btn {
    width: 24px;
    height: 22px;
    border: 1px solid #555;
    border-radius: 3px;
    background: #3a3a3a;
    color: #fff;
    font-size: 1rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
}

.zoom-btn:hover { background: #4a4a4a; }

.zoom-bar {
    padding: 0.4rem 0.5rem;
    background: #1A1A1A;
    border-bottom: 1px solid #444;
}

.zoom-bar .timeline-controls {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    justify-content: center;
}

.transport-wrapper {
    display: flex;
    justify-content: center;
    padding: 0.5rem 0;
}

/* --- Track Row --- */
.track-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.5rem;
    background: #2A2A2A;
    border-bottom: 1px solid #444;
    font-size: 0.8rem;
    font-family: 'Roboto Mono', 'Courier New', monospace;
    white-space: nowrap;
    overflow-x: auto;
}

.track-label {
    font-weight: bold;
    color: #fff;
}

.track-name {
    font-weight: bold;
    color: #fff;
}

.track-name.active {
    color: #FF6DF0;
}

.track-name.next {
    color: #aaa;
}

.track-name.end {
    color: #ff4444;
    font-weight: bold;
}

.track-time {
    color: #aaa;
}

.track-sep {
    color: #666;
    margin: 0 0.25rem;
}

/* --- Scrollable Timeline --- */
.timeline-scroll {
    width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    background: #1A1A1A;
    border: 1px solid #444;
    position: relative;
}

.timeline-scroll::-webkit-scrollbar {
    height: 8px;
}

.timeline-scroll::-webkit-scrollbar-track {
    background: #1A1A1A;
}

.timeline-scroll::-webkit-scrollbar-thumb {
    background: #555;
    border-radius: 4px;
}

.timeline-canvas {
    position: relative;
    height: 140px;
    min-height: 140px;
}

/* --- Ticks (at bottom) --- */
.tick-row {
    position: absolute;
    bottom: 0;
    left: 0;
    height: 20px;
    width: 100%;
    padding-bottom: 2px;
    pointer-events: none;
}

.tick {
    position: absolute;
    bottom: 0;
    transform: translateX(-50%);
}

/* Small tick (1-second marks) */
.tick::before {
    content: '';
    display: block;
    width: 1px;
    height: 5px;
    background: #333;
    margin: 0 auto;
}

/* Label tick (highlighted, taller) */
.tick.tick-label::before {
    height: 15px;
    background: #555;
}

.tick-label {
    display: block;
    font-family: monospace;
    font-size: 0.6rem;
    color: #666;
    text-align: center;
    margin-bottom: 2px;
    white-space: nowrap;
}

/* --- Layer Row (absolute positioning by time) --- */
.layer-row {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    display: flex;
    pointer-events: none;
}

/* Level labels on the left */
.layer-bar {
    position: absolute;
    height: 28px;
    min-width: 4px;
    background: #2A2A2A;
    border: 1px solid #444;
    border-radius: 2px;
    overflow: hidden;
    cursor: default;
    transition: background 0.15s, border-color 0.15s;
    display: flex;
    align-items: center;
}

.layer-bar.layer-active {
    background: #3a3520;
    border-color: #FF6DF0;
    box-shadow: 0 0 4px rgba(255, 215, 0, 0.3);
}

.layer-label {
    display: block;
    color: #ccc;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 0 4px;
    line-height: 28px;
    font-size: 11px;
}

.layer-bar.layer-active .layer-label {
    color: #FF6DF0;
    font-weight: bold;
}

/* --- Playhead --- */
.playhead-line {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: #FF6DF0;
    z-index: 10;
    pointer-events: none;
}

.playhead-marker {
    position: absolute;
    top: 0;
    left: -5px;
    width: 0;
    height: 0;
    border-left: 6px solid transparent;
    border-right: 6px solid transparent;
    border-top: 8px solid #FF6DF0;
}
</style>
