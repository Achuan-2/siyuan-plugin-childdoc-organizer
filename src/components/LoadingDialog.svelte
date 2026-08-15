
<script lang="ts">
    export let message: string;
    export let current: number | null = null;
    export let total: number | null = null;

    $: hasProgress = current !== null && total !== null && total > 0;
    $: percentage = hasProgress
        ? Math.min(100, Math.round((current / total) * 100))
        : 0;
</script>

<div class="loading-dialog">
    {#if hasProgress}
        <div class="progress-text">{current} / {total} ({percentage}%)</div>
        <div
            class="progress-track"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax={total}
            aria-valuenow={current}
        >
            <div class="progress-bar" style={`width: ${percentage}%`}></div>
        </div>
    {:else}
        <div class="loading-spinner"></div>
    {/if}
    <div class="loading-message">{message}</div>
</div>

<style>
.loading-dialog {
    padding: 16px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
}

.loading-spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--b3-theme-background);
    border-top: 3px solid var(--b3-theme-primary);
    border-radius: 50%;
    animation: spin 1s linear infinite;
}

.loading-message {
    font-size: 14px;
    color: var(--b3-theme-on-background);
}

.progress-text {
    font-size: 14px;
    color: var(--b3-theme-on-background);
}

.progress-track {
    width: 100%;
    height: 8px;
    overflow: hidden;
    border-radius: 4px;
    background: var(--b3-theme-surface-lighter);
}

.progress-bar {
    height: 100%;
    border-radius: inherit;
    background: var(--b3-theme-primary);
    transition: width 0.2s ease;
}

@keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
}
</style>
