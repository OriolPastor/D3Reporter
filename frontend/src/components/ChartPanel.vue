<script setup>
import { computed, isRef } from 'vue'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart, BarChart } from 'echarts/charts'
import {
  TitleComponent,
  TooltipComponent,
  GridComponent,
} from 'echarts/components'

use([
  CanvasRenderer,
  LineChart,
  BarChart,
  TitleComponent,
  TooltipComponent,
  GridComponent,
])

const GRAFANA_COLORS = [
  '#73BF69', '#FF9830', '#5794F2', '#F2495C',
  '#F2CC04', '#82BFF2', '#BA43A9',
]

const props = defineProps({
  chartType: { type: String, default: 'line' },
  title: { type: String, required: true },
  unit: { type: String, default: '' },
  dataArrays: { type: Array, required: true },
  seriesNames: { type: Array, required: true },
  thresholds: { type: Array, default: () => [] },
  seriesColors: { type: Array, default: () => [] },
})

function getArr(a) {
  return isRef(a) ? a.value : a
}

const chartOption = computed(() => {
  const arrays = props.dataArrays || []
  const hasData = arrays.some(a => {
    const v = getArr(a)
    return v && v.length > 0
  })

  const dataLength = Math.max(1, ...arrays.map(a => {
    const v = getArr(a)
    return v ? v.length : 0
  }))

  const series = arrays.map((a, i) => {
    const arr = getArr(a)
    const data = Array.from({ length: dataLength }, (_, j) =>
      (arr && arr[j] !== undefined) ? arr[j] : 0
    )
    const color = props.seriesColors[i] || GRAFANA_COLORS[i % GRAFANA_COLORS.length]
    const thresholds = props.thresholds[i]
    const markLine = thresholds
      ? {
          symbol: 'none',
          data: [
            { name: 'Critical', yAxis: thresholds.critical, lineStyle: { color: '#F2495C', type: 'dashed', width: 1.5 }, label: { formatter: `Critical: ${thresholds.critical}${props.unit}`, color: '#F2495C', fontSize: 10 } },
            { name: 'Warning', yAxis: thresholds.warning, lineStyle: { color: '#F2CC04', type: 'dashed', width: 1.5 }, label: { formatter: `Warning: ${thresholds.warning}${props.unit}`, color: '#F2CC04', fontSize: 10 } },
          ],
        }
      : undefined
    return {
      name: props.seriesNames[i] || '',
      type: props.chartType,
      data,
      lineStyle: props.chartType === 'line' ? { color } : undefined,
      areaStyle: props.chartType === 'line' ? (hasData ? { opacity: 0.1 } : undefined) : undefined,
      symbol: props.chartType === 'line' ? 'none' : undefined,
      smooth: props.chartType === 'line' ? false : undefined,
      markLine,
      itemStyle: props.chartType === 'bar' ? { color } : undefined,
    }
  })

  const xData = Array.from({ length: dataLength }, (_, j) => {
    const d = new Date(Date.now() - (dataLength - 1 - j) * 2000)
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  })

  return {
    animation: false,
    title: {
      text: props.title,
      left: 'center',
      textStyle: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line' },
      backgroundColor: '#1e1e1e',
      borderColor: '#333',
      textStyle: { color: '#fff' },
      formatter: (params) => {
        const list = Array.isArray(params) ? params : [params]
        return list.map((p, idx) => {
          const color = p.color || (props.seriesColors[idx] || GRAFANA_COLORS[idx % GRAFANA_COLORS.length])
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
      boundaryGap: false,
      data: xData,
      axisLine: { lineStyle: { color: '#333' } },
      axisLabel: { color: '#888', fontSize: 10, interval: 'auto' },
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
    series,
  }
})
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
