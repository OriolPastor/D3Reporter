<template>
    <div class="track-section">
        <div class="centered-group">
            <div class="small-info">Track: {{ currentTrackName }} &nbsp;|&nbsp; Playhead: {{ formattedPlayhead }} &nbsp;|&nbsp; {{ currentLayerInfo }} &nbsp;|&nbsp; {{ nextLayerInfo }} &nbsp;|&nbsp; Layers in timeline: {{ layerCount }} &nbsp;|&nbsp; Active Layers: {{ activeLayerCount }}</div>
            <div class="transport-wrapper">
                <TransportControls :liveUpdate="liveUpdate" />
            </div>
        </div>

        <details open style="margin-top: 30px;">
            <summary style="cursor: pointer; font-weight: bold;">Layer & Asset Table <span class="notation">(click to collapse)</span></summary>
            <div class="track-frame">
                <table class="track-table">
                    <thead>
                        <tr>
                            <th class="col-time">Start Time</th>
                            <th class="col-layer">Layer Name</th>
                            <th class="col-asset">Video Asset</th>
                            <th class="col-time">End Time</th>
                            <th class="col-time">Time</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="(track, index) in allTracksSorted" :key="track.trackLayer" :class="{ 'active-row': isActiveRow(track)}">
                            <td class="col-time">{{ track.startTime }}</td>
                            <td class="col-layer">{{ track.trackLayer }}</td>
                            <td class="col-asset">{{ track.videoAsset }}</td>
                            <td class="col-time">{{ track.endTime }}</td>
                            <td class="col-time">{{ track.time }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </details>
    </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import TransportControls from './TransportControls.vue';
import { usePlayhead } from '../composables/usePlayhead';

const props = defineProps({
        liveUpdate: {
            type: Object,
            required: true
        }
    });

    // Playhead subscription (created lazily in onMounted)
    const playhead = usePlayhead();

    //Get current track name
    const { currentTrackName } = props.liveUpdate.subscribe('GuiSystem.currentTransportManager', {
        currentTrackName: 'object.track.description'
    });

    // Active layers count (transport manager)
    const { activeLayers } = props.liveUpdate.subscribe('GuiSystem.currentTransportManager', {
        activeLayers: 'object.player.activeLayers'
    });
    const activeLayerCount = computed(() => {
        return Array.isArray(activeLayers.value) ? activeLayers.value.length : 0;
    });

    // Track layers — count triggers dynamic subscriptions
    const { trackLayerArray } = props.liveUpdate.subscribe('GuiSystem.currentTransportManager', {
        trackLayerArray: 'object.track.layers'
    });
    const layerCount = computed(() => {
        return Array.isArray(trackLayerArray.value) ? trackLayerArray.value.length : 0;
    });

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
    // Dynamically get a list of track layers
    const trackLayerData = ref({});

    // Watch for layer count changes and subscribe to the track layers
    watch(
        () => layerCount.value,
        (count) => {
            if (!count) return;
            const trackSubscriptions = {};
            for (let i = 0; i < count; i++) {
                trackSubscriptions[`trackLayer${i}`] = `object.track.layers[${i}].name`;
            }
            trackLayerData.value = props.liveUpdate.subscribe('GuiSystem.currentTransportManager', trackSubscriptions);
        }
    )

    // Extract track layer names from the data
    const trackLayerNames = computed(() => {
        if (!trackLayerData.value) return [];
        return Object.entries(trackLayerData.value).map(([key, rawValue]) => ({
            id: key,
            name: typeof rawValue === 'string' && rawValue.length > 0 ? rawValue : '(Unnamed)',
        }));
    });

    // Pull the asset paths for each layer
    const layerVideoAssetData = ref({});
    watch(
        () => layerCount.value,
        (count) => {
            if (!count) return;
            const layerSubscriptions = {};
            for (let i = 0; i < count; i++) {
                layerSubscriptions[`layerVideoAsset${i}`] = `object.track.layers[${i}].fields[10].sequence.keys`;
            }
            // console.log('Layer Video Asset Subscriptions:', layerSubscriptions);

            layerVideoAssetData.value = props.liveUpdate.subscribe('GuiSystem.currentTransportManager', layerSubscriptions);
        }
    );

    //Clean the paths names and eliminate the 'objects/videoclip/' prefix
    const allTrackVideoAssets = computed(() => {
        if (!layerVideoAssetData.value) return [];

        return Object.entries(layerVideoAssetData.value).map(([key, refValue]) => {
            const raw = refValue?.value ?? refValue;

            let assetPath = '(No Asset)';
            if (Array.isArray(raw) && raw.length >0) {
                const fullAssetPath = raw[0]?.r?.path ?? '';
                const pathNoApxTail = fullAssetPath.replace(/\.apx$/, '');
                assetPath = pathNoApxTail.replace(/^objects\/videoclip\//, '');
            }

            return {
                id: key,
                assetPath
            }
        })
    });
    
    // Getting the track layer timing
    const layerStartTimeData = ref({});
    watch(
        () => layerCount.value,
        (count) => {
            if (!count) return;
            const timeSubscriptions = {};
            for (let i = 0; i < count; i++) {
                timeSubscriptions[`startTime${i}`] = `object.track.layers[${i}].tStart`;
            }
            // console.log('Layer Start Time Subscriptions:', layerStartSubscriptions);

            layerStartTimeData.value = props.liveUpdate.subscribe('GuiSystem.currentTransportManager', timeSubscriptions);
        }
    );
    const allLayerStartTimes = computed(() => {
        if (!layerStartTimeData.value) return [];

        return Object.entries(layerStartTimeData.value).map(([key, refValue]) => {
            const raw = refValue?.value ?? refValue;
            return {
                id: key,
                startTime: typeof raw === 'number' ? raw.toFixed(2) : 0
            }
        });
    });
    //Getting track layer end times
    const layerEndTimeData = ref({});
    watch(
        () => layerCount.value,
        (count) => {
            if (!count) return;
            const endTimeSubscriptions = {};
            for (let i = 0; i < count; i++) {
                endTimeSubscriptions[`endTime${i}`] = `object.track.layers[${i}].tEnd`;
            }
            // console.log('Layer End Time Subscriptions:', endTimeSubscriptions);

            layerEndTimeData.value = props.liveUpdate.subscribe('GuiSystem.currentTransportManager', endTimeSubscriptions);
        }
    );
    const allLayerEndTimes = computed(() => {
        if (!layerEndTimeData.value) return [];

        return Object.entries(layerEndTimeData.value).map(([key, refValue]) => {
            const raw = refValue?.value ?? refValue;
            return {
                id: key,
                endTime: typeof raw === 'number' ? raw.toFixed(2) : 0
            }
        });
    });

    // Reactive time that updates every second for active rows
    const currentTime = ref(new Date().toLocaleTimeString('en-GB'));
    let timeInterval = null;

    onMounted(() => {
        // Create the playhead subscription NOW — before any computed evaluation
        playhead.subscribe(props.liveUpdate);

        // Polling clock for active rows
        timeInterval = setInterval(() => {
            currentTime.value = new Date().toLocaleTimeString('en-GB');
        }, 1000);

        // Re-create dynamic subscriptions with fresh IDs
        const count = layerCount.value;
        if (count > 0) {
            const nameSubs = {};
            const assetSubs = {};
            const startSubs = {};
            const endSubs = {};
            for (let i = 0; i < count; i++) {
                nameSubs[`trackLayer${i}`] = `object.track.layers[${i}].name`;
                assetSubs[`layerVideoAsset${i}`] = `object.track.layers[${i}].fields[10].sequence.keys`;
                startSubs[`startTime${i}`] = `object.track.layers[${i}].tStart`;
                endSubs[`endTime${i}`] = `object.track.layers[${i}].tEnd`;
            }
            trackLayerData.value = props.liveUpdate.subscribe('GuiSystem.currentTransportManager', nameSubs);
            layerVideoAssetData.value = props.liveUpdate.subscribe('GuiSystem.currentTransportManager', assetSubs);
            layerStartTimeData.value = props.liveUpdate.subscribe('GuiSystem.currentTransportManager', startSubs);
            layerEndTimeData.value = props.liveUpdate.subscribe('GuiSystem.currentTransportManager', endSubs);
        }
    });

    onBeforeUnmount(() => {
        if (timeInterval) clearInterval(timeInterval);
        timeInterval = null;
    });

    // Combine track layer names with their corresponding video assets
    const allTracksReported = computed(() => {
        const ph = playhead.value.value ?? 0;
        return trackLayerNames.value.map((trackLayer, i) => {
            const start = Number(allLayerStartTimes.value[i]?.startTime);
            const end = Number(allLayerEndTimes.value[i]?.endTime);
            const isActive = ph >= start && ph < end;
            const time = isActive ? currentTime.value : '';
            return {
                trackLayer: trackLayer.name,
                videoAsset: allTrackVideoAssets.value[i]?.assetPath || '(No Asset)',
                startTimeSeconds: start,
                startTime: formatTimecode(start),
                endTimeSeconds: end,
                endTime: formatTimecode(end),
                time,
            }
        })
    })

    const allTracksSorted = computed(() => {
        return [...allTracksReported.value].sort((a, b) => a.startTimeSeconds - b.startTimeSeconds)
        });

    // Current layer info (layer where playhead is currently)
    const currentLayerInfo = computed(() => {
        const ph = playhead.value.value ?? 0;
        const current = allTracksSorted.value.find(t => ph >= t.startTimeSeconds && ph < t.endTimeSeconds);
        if (!current) return '';
        const elapsed = ph - current.startTimeSeconds;
        return `${current.trackLayer} +${formatTimecode(elapsed)}`;
    });

    // Next layer info (next layer that starts after playhead)
    const nextLayerInfo = computed(() => {
        const ph = playhead.value.value ?? 0;
        const next = allTracksSorted.value.find(t => t.startTimeSeconds > ph);
        if (!next) return '';
        const diff = next.startTimeSeconds - ph;
        return `${next.trackLayer} -${formatTimecode(diff)}`;
    });

    // Checking playhead position against track start and end times
    function isActiveRow(row) {
        const ph = playhead.value.value ?? 0
        return ph >= row.startTimeSeconds && ph < row.endTimeSeconds;
    }
</script>

<style scoped>
    .track-section {
        margin: 0;
        width: 100%;
    }
    .centered-group {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        width: 100%;
    }
    .transport-wrapper {
        display: flex;
        justify-content: center;
        margin-top: 20px;
        margin-bottom: 10px;
    }
    .track-frame {
        border: none;
        border-radius: 0;
        padding: 0;
        overflow: visible;
        max-width: 100%;
        width: 100%;
    }
    .big-bold {
        font-size: 1.2rem;
        font-weight: bold;
    }
    .small-info {
        font-size: 1rem;
        font-weight: 600;
        color: #e0e0e0;
        white-space: nowrap;
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
    .track-table {
        width: 100%;
        border-collapse: separate;
        border-spacing: 0;
        margin-top: 1em;
        table-layout: fixed;
    }

    .track-table th,
    .track-table td {
        padding: 8px 16px;
        border: none;
        text-align: left;
    }

    .col-time {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: #6a5acd;
        width: 18%;
    }

    .col-layer {
        font-weight: bold;
        width: 22%;
    }

    .col-asset {
        font-style: italic;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        width: 40%;
    }
    .track-table th {
        font-weight: bold;
    }

    .notation {
        font-style: italic;
        font-size: 0.8rem;
        font-weight: lighter;
    }
    .active-row td {
        border-bottom: 2px solid #FF6DF0;
        border-top: 2px solid #FF6DF0;
    }
    .active-row td:first-child {
        border-left: 2px solid #FF6DF0;
    }
    .active-row td:last-child {
        border-right: 2px solid #FF6DF0;
    }
    .button-blue {
        box-shadow:inset 0px 1px 0px 0px #8e8ef5;
        background:linear-gradient(to bottom, #379bf2 5%, #271fc6 100%);
        background-color:#373df2;
        border-radius:6px;
        border:1px solid #2118d0;
        display:inline-block;
        cursor:pointer;
        color:#ffffff;
        font-family:Arial;
        font-size:15px;
        font-weight:bold;
        padding:6px 24px;
        text-decoration:none;
        text-shadow:0px 1px 0px #810e05;
    }
    .button-blue:hover {
        background:linear-gradient(to bottom, #271fc6 5%, #379bf2 100%);
        background-color:#131388;
    }
</style>