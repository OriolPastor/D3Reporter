<script setup>
import { computed, watch } from 'vue';

const props = defineProps({
    liveUpdate: { type: Object, required: true }
});

// --- Centralized transport state via liveUpdate (replaces polling) ---
const transport = props.liveUpdate.subscribe('GuiSystem.currentTransportManager', {
    playMode: 'object.player.playMode',
    activeLayers: 'object.player.activeLayers',
    currentTrackName: 'object.track.description',
    currentTrackUid: 'object.track.uid',
    setListTracks: 'object.setList.tracks',
});

const playMode = computed(() => transport.playMode?.value ?? '');
const currentTrackName = computed(() => transport.currentTrackName?.value ?? '--');
const currentTrackUid = computed(() => transport.currentTrackUid?.value ?? '');
const setListTracks = computed(() => transport.setListTracks?.value ?? []);

const isPlaying = computed(() => {
    const mode = playMode.value;
    return ['play', 'playsection', 'loopsection'].includes(mode);
});

// --- Mode display ---
const modeLabel = computed(() => {
    switch (playMode.value) {
        case 'play': return 'PLAY';
        case 'playsection': return 'PLAY TO END';
        case 'loopsection': return 'LOOP';
        default: return 'STOPPED';
    }
});

const modeAnimSpeed = computed(() => {
    if (playMode.value === 'playsection') return '0.5s';
    if (playMode.value === 'play' || playMode.value === 'loopsection') return '1s';
    return '2s';
});

// --- Track index from setList ---
function uidToHex(val) {
    if (typeof val === 'string') return val.toLowerCase();
    if (typeof val === 'number') return '0x' + BigInt(val).toString(16);
    return '';
}

const currentTrackIndex = computed(() => {
    const uidHex = uidToHex(currentTrackUid.value);
    if (!uidHex || setListTracks.value.length === 0) return 0;
    return setListTracks.value.findIndex(t => uidToHex(t.uid) === uidHex);
});

watch([currentTrackIndex, currentTrackUid, setListTracks], ([idx, uid, tracks]) => {
    // console.log('[TC] prevTrack guard check: uid=', uid, 'type=', typeof uid, 'uidHex=', uidToHex(uid), 'tracks=', tracks.map(t => t.uid), 'index=', idx);
}, { immediate: true, deep: true });

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
        case 'Enter':
            e.preventDefault();
            togglePlay();
            break;
        case ',':
            e.preventDefault();
            prevSection();
            break;
        case '.':
            e.preventDefault();
            nextSection();
            break;
        case 'r':
        case 'R':
            if (e.ctrlKey) {
                e.preventDefault();
                returnToStart();
            }
            break;
    }
}
</script>

<template>
    <div class="transport-controls">
        <div class="transport-row">
            <!-- 1. Play -->
            <button class="tbtn play-btn" :class="{ 'is-playing': isPlaying }" @click="togglePlay" :title="isPlaying ? 'Stop' : 'Play (Enter)'">
                <span class="icon">{{ isPlaying ? '■' : '▶' }}</span>
            </button>
            <!-- 2. Play-to-end-of-section -->
            <button class="tbtn playsection-btn" :class="{ 'is-playing': playMode === 'playsection' }" @click="playSection" title="Play-to-end-of-section (Space)">
                <span class="icon">▶<span style="font-size:0.65em">⏺</span></span>
            </button>
            <!-- 3. Loop-section -->
            <button class="tbtn loop-btn" :class="{ 'is-playing': playMode === 'loopsection' }" @click="loopSection" title="Loop section (Shift)">
                <span class="icon">▶↺</span>
            </button>
            <!-- 4. Stop -->
            <button class="tbtn" @click="stop" title="Stop">
                <span class="icon">■</span>
            </button>
            <!-- 5. Previous section -->
            <button class="tbtn" @click="prevSection" title="Previous section (,)">
                <span class="icon"><span class="bar">│</span>◀</span>
            </button>
            <!-- 6. Next section -->
            <button class="tbtn" @click="nextSection" title="Next section (.)">
                <span class="icon">▶<span class="bar">│</span></span>
            </button>
            <!-- 7. Return-to-start-of-track -->
            <button class="tbtn" @click="returnToStart" title="Return to start (Ctrl+R)">
                <span class="icon">⮌</span>
            </button>
            <!-- 8. Previous track (setlist) -->
            <button class="tbtn" @click="prevTrack" title="Previous track from setlist">
                <span class="icon">▲</span>
            </button>
            <!-- 9. Next track (setlist) -->
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
    width: 48px;
    height: 40px;
    border: none;
    border-radius: 3px;
    background: #3a3a3a;
    color: #ffffff;
    font-size: 1.1rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
}

.tbtn .icon {
    line-height: 1;
    font-size: 1.1rem;
}

.tbtn:hover {
    background: #4a4a4a;
}

.tbtn:active {
    opacity: 0.6;
}

.prev-btn .icon::before {
    content: '\2502';
    font-size: 0.7em;
    margin-right: 2px;
}

.next-btn .icon::after {
    content: '\2502';
    font-size: 0.7em;
    margin-left: 2px;
}

/* Play button */
.play-btn.is-playing {
    animation: flash-btn 1s infinite;
}

/* Play-to-end button */
.playsection-btn.is-playing {
    animation: flash-btn-section 0.5s infinite;
}

/* Loop button */
.loop-btn.is-playing {
    animation: flash-btn 1s infinite;
}

.mode-badge {
    padding: 0.2rem 0.6rem;
    border-radius: 3px;
    font-size: 0.7rem;
    font-weight: bold;
    font-family: monospace;
    animation: flash-mode 2s infinite;
    color: #379bf2;
    border: 1px solid #379bf2;
    background: #379bf222;
    flex-shrink: 0;
}

.transport-info {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    font-size: 0.75rem;
    color: #aaa;
}

@keyframes flash-btn {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
}

@keyframes flash-btn-section {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
}

@keyframes flash-mode {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
}
</style>
