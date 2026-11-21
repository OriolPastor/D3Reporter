<script setup>
import { computed } from 'vue'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { BarChart } from 'echarts/charts'
import {
  TitleComponent,
  TooltipComponent,
  GridComponent,
} from 'echarts/components'

use([
  CanvasRenderer,
  BarChart,
  TitleComponent,
  TooltipComponent,
  GridComponent,
])

const GRAFANA_COLORS = ['#FF6DF0', '#b065d0', '#6a5acd']

const props = defineProps({
  title: { type: String, required: true },
  unit: { type: String, default: '' },
  current: { type: Number, default: 0 },
  working: { type: Number, default: 0 },
  peak: { type: Number, default: 0 },
})

const chartOption = computed(() => ({
  animation: false,
  title: {
    text: props.title,
    left: 'center',
    textStyle: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  },
  tooltip: {
    trigger: 'axis',
    axisPointer: { type: 'shadow' },
    backgroundColor: '#1e1e1e',
    borderColor: '#333',
    textStyle: { color: '#fff' },
    formatter: (params) => {
      const list = Array.isArray(params) ? params : [params]
      return list.map((p, idx) => {
        const color = p.color || GRAFANA_COLORS[idx % GRAFANA_COLORS.length]
        return `<div style="display:flex;align-items:center;gap:6px;">
          <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};"></span>
          <span>${p.seriesName}:</span>
          <span style="font-weight:bold;margin-left:auto;padding-left:12px;">${p.value}${props.unit}</span>
        </div>`
      }).join('')
    },
  },
  grid: {
    left: '3%',
    right: '3%',
    top: '15%',
    bottom: '18%',
    containLabel: true,
  },
  xAxis: {
    type: 'category',
    data: ['Usage'],
    axisLine: { lineStyle: { color: '#333' } },
    axisLabel: { color: '#888', fontSize: 10 },
  },
  yAxis: {
    type: 'value',
    axisLine: { lineStyle: { color: '#333' } },
    axisLabel: {
      color: '#888',
      formatter: props.unit ? (v) => `${v} ${props.unit}` : '{value}',
    },
    splitLine: { lineStyle: { color: '#222' } },
  },
  series: [
    {
      name: 'Current Usage',
      type: 'bar',
      data: [props.current],
      itemStyle: { color: GRAFANA_COLORS[0] },
      barWidth: '20%',
    },
    {
      name: 'Working Set',
      type: 'bar',
      data: [props.working],
      itemStyle: { color: GRAFANA_COLORS[1] },
      barWidth: '20%',
    },
    {
      name: 'Peak Usage',
      type: 'bar',
      data: [props.peak],
      itemStyle: { color: GRAFANA_COLORS[2] },
      barWidth: '20%',
    },
  ],
}))
</script>

<template>
  <v-chart :option="chartOption" style="width: 100%; height: 300px;" class="chart-panel" />
</template>

<style scoped>
.chart-panel {
  width: 100%;
  height: 300px;
  background: #161616;
  border: 1px solid #333;
  border-radius: 6px;
}
</style>
