import { ref } from 'vue'
import { useLiveUpdateStore } from '../stores/liveUpdateStore'

/**
 * Bridges our WebSocket service to the liveUpdate.subscribe() API
 * expected by TrackDetail.vue (calco de @disguise-one/vue-liveupdate).
 */
export function useLiveUpdateCompat() {
    const store = useLiveUpdateStore()
    const status = ref('CLOSED')
    let ws = null
    // Frontend subscriptions (alias → { objectPath, propPath, ref, callback })
    const frontendSubscriptions = new Map()
    // ID map construido a partir de la confirmación del Director (reenviada por el backend)
    let keyToId = {}
    let idToKey = {}

    function connect() {
        const wsUrl = `ws://${window.location.host}/ws`
        ws = new WebSocket(wsUrl)

        ws.onopen = () => { status.value = 'OPEN' }
        ws.onclose = () => { status.value = 'CLOSED' }
        ws.onerror = () => { status.value = 'CLOSED' }

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data)
                // Confirmación de suscripciones (ID map del Director)
                if (msg.subscriptions) {
                    // Guardar ID map del Director para matching de valuesChanged
                    // No tocar frontendSubscriptions — el matching usa propertyPath
                    for (const sub of msg.subscriptions) {
                        keyToId[`${sub.objectPath}/${sub.propertyPath}`] = sub.id
                        idToKey[sub.id] = `${sub.objectPath}/${sub.propertyPath}`
                    }
                    return
                }
                // Playhead directo
                if (msg.playhead !== undefined) {
                    store.updatePlayhead(msg.playhead)
                    // Also update all tRender subscribers
                    for (const [, sub] of frontendSubscriptions) {
                        if (sub.propPath && sub.propPath.includes('tRender')) {
                            sub.ref.value = msg.playhead
                        }
                    }
                    return
                }
                // Track layers initial push (raw array from backend)
                if (msg.trackLayers && Array.isArray(msg.trackLayers)) {
                    for (const [, sub] of frontendSubscriptions) {
                        if (sub.propPath === 'object.track.layers') {
                            sub.ref.value = msg.trackLayers
                        }
                    }
                    return
                }
                // Valores dinámicos (track layers, assets, etc.)
                if (msg.valuesChanged) {
                    for (const change of msg.valuesChanged) {
                        // Try matching by propertyPath first, then by id
                        let sub = null
                        if (change.propertyPath) {
                            for (const [, s] of frontendSubscriptions) {
                                if (s.propPath === change.propertyPath) {
                                    sub = s
                                    break
                                }
                            }
                        }
                        if (!sub) {
                            sub = frontendSubscriptions.get(change.id)
                        }
                        if (sub) {
                            sub.ref.value = change.value
                            if (sub.callback) sub.callback(change.value)
                        }
                    }
                }
            } catch (e) {
                // ignore parse errors
            }
        }
    }

    function subscribe(objectPath, properties) {
        const result = {}
        const subs = []

        for (const [alias, propPath] of Object.entries(properties)) {
            const refValue = ref(undefined)

            const subKey = `${objectPath}/${propPath}`
            const subObj = { objectPath, propPath, ref: refValue, callback: null, alias }
            frontendSubscriptions.set(subKey, subObj)
            subs.push(propPath)

            result[alias] = refValue
        }

        // Send subscription request to backend (reenvía al Director)
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ subscribe: { object: objectPath, properties: subs } }))
        }

        return result
    }

    connect()

    return {
        status,
        subscribe,
    }
}
