<template>
    <div class="playhead-section">
        <h2>Current Playhead Position</h2>
        <div class="playhead">
            {{ formattedPlayhead }}
        </div>
    </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { usePlayhead } from '../composables/usePlayhead';

const props = defineProps({
    liveUpdate: {
        type: Object,
        required: true
    }
});

const playhead = usePlayhead();

function formatTimecode(seconds) {
    if (typeof seconds !== 'number' || isNaN(seconds)) return '00:00:00:00'
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = Math.floor(seconds % 60)
    const fps = 60
    const frame = Math.floor(((seconds % 1) * fps) % fps)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(frame).padStart(2, '0')}`
}

const formattedPlayhead = computed(() => {
    const val = playhead.value.value
    return formatTimecode(val)
})

onMounted(() => {
    playhead.subscribe(props.liveUpdate);
});
</script>

<style scoped>
    .playhead-section {
        margin: 1rem;
        padding: 1rem;
        border: 1px solid #ccc;
        border-radius: 4px;
    }
    .playhead {
        font-size: 1.2rem;
        font-weight: bold;
        color: #4a90e2;
    }
    .italic {
        font-style: italic;
    }
    .separator {
        margin: 0 0.5rem;
    }
    .left {
        text-align: left;
    }
    .notation {
        font-style: italic;
        font-size: 0.8rem;
        font-weight: lighter;
    }
</style>
