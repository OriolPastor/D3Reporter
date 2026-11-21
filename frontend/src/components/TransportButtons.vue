<script setup>
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { usePlayhead } from '../composables/usePlayhead';

const props = defineProps({
    liveUpdate: { type: Object, required: true }
});

// --- LiveUpdate subscriptions ---
const tRender = usePlayhead(props.liveUpdate);

const { currentTrackName } = props.liveUpdate.subscribe('GuiSystem.currentTransportManager', {
    currentTrackName: 'object.track.description'
});

// --- Active transport polling via backend proxy ---
const activeTransport = ref(null);
const playMode = ref('');
const isPlaying = ref(false);
const sectionInfo = ref('--');
const currentTrackIndex = ref(0);
let pollTimer = null;

function uidToHex(val) {
    if (typeof val === 'string') return val.toLowerCase();
    if (typeof val === 'number') return '0x' + BigInt(val).toString(16);
    return '';
}

async function fetchActiveTransport() {
    try {
        const res = await fetch('/api/transport/activetransport');
        const json = await res.json();
        if (json.status?.code === 0 && json.result?.length > 0) {
            activeTransport.value = json.result[0];
            const t = json.result[0];
            playMode.value = t.playmode || '';
            sectionInfo.value = t.currentTrack?.name || '--';
            isPlaying.value = ['play', 'playsection', 'loopsection'].includes(t.playmode);
            if (t.setList?.tracks?.length > 0) {
                const trackUidHex = uidToHex(t.currentTrack?.uid);
                const idx = t.setList.tracks.findIndex(tr => uidToHex(tr.uid) === trackUidHex);
                currentTrackIndex.value = idx >= 0 ? idx : 0;
            }
        }
    } catch { /* silent */ }
}

onMounted(() => {
    fetchActiveTransport();
    pollTimer = setInterval(fetchActiveTransport, 1000);
});

onUnmounted(() => {
    if (pollTimer) clearInterval(pollTimer);
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

const playheadTime = computed(() => formatTimecode(tRender.value ?? 0));

// --- Transport actions via backend proxy ---
async function transportCommand(path) {
    try {
        await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    } catch (e) {
        // console.error('Transport command failed:', path, e);
    }
}

async function togglePlay() {
    if (isPlaying.value) {
        await transportCommand('/api/transport/stop');
    } else {
        await transportCommand('/api/transport/play');
    }
}

async function stop() {
    await transportCommand('/api/transport/stop');
}

async function returnToStart() {
    await transportCommand('/api/transport/returntostart');
}

async function prevSection() {
    await transportCommand('/api/transport/gotoprevsection');
}

async function nextSection() {
    await transportCommand('/api/transport/gotonextsection');
}

async function prevTrack() {
    if (currentTrackIndex.value < 0) return;
    await transportCommand('/api/transport/gotoprevtrack');
}

async function nextTrack() {
    await transportCommand('/api/transport/gotonexttrack');
}

async function playSection() {
    await transportCommand('/api/transport/playsection');
}

async function loopSection() {
    await transportCommand('/api/transport/playloopsection');
}

// --- Keyboard shortcuts ---
function handleKeydown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    switch (e.key) {
        case 'Enter': e.preventDefault(); togglePlay(); break;
        case ',': e.preventDefault(); prevSection(); break;
        case '.': e.preventDefault(); nextSection(); break;
        case 'r': case 'R':
            if (e.ctrlKey) { e.preventDefault(); returnToStart(); }
            break;
    }
}

onMounted(() => { window.addEventListener('keydown', handleKeydown); });
onUnmounted(() => { window.removeEventListener('keydown', handleKeydown); });
</script>

<template>
    <div class="transport-controls">
        <div class="transport-row">
            <button class="tbtn play-btn" :class="{ 'is-playing': isPlaying }" @click="togglePlay" :title="isPlaying ? 'Stop' : 'Play (Enter)'">
                <span class="icon">{{ isPlaying ? '■' : '▶' }}</span>
            </button>
            <button class="tbtn playsection-btn" :class="{ 'is-playing': playMode === 'playsection' }" @click="playSection" title="Play-to-end-of-section (Space)">
                <span class="icon">▶<span style="font-size:0.65em">⏺</span></span>
            </button>
            <button class="tbtn loop-btn" :class="{ 'is-playing': playMode === 'loopsection' }" @click="loopSection" title="Loop section (Shift)">
                <span class="icon">▶↺</span>
            </button>
            <button class="tbtn" @click="stop" title="Stop">
                <span class="icon">■</span>
            </button>
            <button class="tbtn" @click="prevSection" title="Previous section (,)">
                <span class="icon">⏮</span>
            </button>
            <button class="tbtn" @click="nextSection" title="Next section (.)">
                <span class="icon">⏭</span>
            </button>
            <button class="tbtn" @click="returnToStart" title="Return to start (Ctrl+R)">
                <span class="icon">⮌</span>
            </button>
            <button class="tbtn" @click="prevTrack" title="Previous track from setlist">
                <span class="icon">▲</span>
            </button>
            <button class="tbtn" @click="nextTrack" title="Next track from setlist">
                <span class="icon">▼</span>
            </button>
        </div>
    </div>
</template>

<style scoped>
.transport-controls {
    margin: 1rem 0;
    padding: 0.75rem;
}

.transport-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.5rem;
}

.tbtn {
    width: 72px;
    height: 60px;
    border: none;
    border-radius: 6px;
    background: #3a3a3a;
    color: #ffffff;
    font-size: 1.8rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
}

.tbtn .icon {
    line-height: 1;
    font-size: 1.8rem;
}

.tbtn:hover {
    background: #4a4a4a;
}

.tbtn:active {
    opacity: 0.6;
}

.play-btn.is-playing {
    animation: flash-btn 1s infinite;
}

.playsection-btn.is-playing {
    animation: flash-btn-section 0.5s infinite;
}

.loop-btn.is-playing {
    animation: flash-btn 1s infinite;
}

@keyframes flash-btn {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
}

@keyframes flash-btn-section {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
}
</style>
