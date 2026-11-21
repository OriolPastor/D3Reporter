// src/router/index.js
import { createRouter, createWebHistory } from 'vue-router'
import TrackDetail from '../components/TrackDetail.vue'
import Timeline from '../components/Timeline.vue'
import MetricsView from '../views/MetricsView.vue'

const routes = [
    { path: '/track-detail', name: 'TrackDetail', component: TrackDetail },
    { path: '/timeline', name: 'Timeline', component: Timeline },
    { path: '/metrics', name: 'Metrics', component: MetricsView },
    {path: '/', redirect: '/track-detail'}
]

const router = createRouter({
    history: createWebHistory(),
    routes
})

export default router
