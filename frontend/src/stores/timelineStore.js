import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import axios from 'axios'

export const useTimelineStore = defineStore('timeline', () => {
  const playhead = ref(0)
  const activeLayers = ref([])
  const trackLayers = ref([])
  const layerNames = ref([])
  const videoAssetList = ref([])
  const layerReported = ref([])
  const lastUpdate = ref(null)
  const error = ref(null)

  const activeLayerCount = computed(() => activeLayers.value.length)

  const formattedPlayhead = computed(() => {
    const secs = Math.floor(playhead.value % 60)
    const mins = Math.floor(playhead.value / 60)
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  })

  async function fetchTimeline() {
    try {
      const res = await axios.get('/api/timeline')
      playhead.value = res.data.playhead ?? 0
      activeLayers.value = res.data.activeLayers ?? []
      trackLayers.value = res.data.trackLayers ?? []
      layerNames.value = res.data.layerNames ?? []
      videoAssetList.value = res.data.videoAssetList ?? []
      layerReported.value = res.data.layerReported ?? []
      lastUpdate.value = new Date()
      error.value = null
    } catch (err) {
      error.value = err.message
    }
  }

  return {
    playhead, activeLayers, trackLayers,
    layerNames, videoAssetList, layerReported,
    activeLayerCount, formattedPlayhead,
    lastUpdate, error, fetchTimeline,
  }
})
