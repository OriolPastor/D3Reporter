import { onMounted, ref, watch } from 'vue';

/**
 * Returns a reactive playhead value that updates in real-time.
 * The subscription is created lazily when subscribe() is called,
 * allowing the component to defer subscription creation until
 * onMounted where all subscriptions can be batched together.
 */
export function usePlayhead() {
    const currentTRender = ref(0);
    let tRenderRef = null;

    return {
        value: currentTRender,
        /**
         * Call this from onMounted to create the liveUpdate subscription.
         * @param {Object} liveUpdate - The liveUpdate instance
         */
        subscribe(liveUpdate) {
            const { tRender } = liveUpdate.subscribe('GuiSystem.currentTransportManager', {
                tRender: 'object.player.tRender'
            });
            tRenderRef = tRender;
            // Read current value from subscription ref
            if (typeof tRender.value === 'number') {
                currentTRender.value = tRender.value;
            }
            // Sync with subscription updates
            watch(() => tRender.value, (val) => {
                if (typeof val === 'number') {
                    currentTRender.value = val;
                }
            });
        }
    };
}
