(() => {
    const id = document.currentScript.dataset.id;
    const token = document.querySelector('meta[name="favorites-csrf-token"]')?.content;
    function record() {
        if (!token || document.visibilityState !== 'visible' || document.prerendering) return;
        document.removeEventListener('visibilitychange', record);
        document.removeEventListener('prerenderingchange', record);
        fetch('/api/listing-views/' + encodeURIComponent(id), {
            method: 'POST', headers: { 'X-CSRF-Token': token }, keepalive: true
        }).catch(() => {});
    }
    document.addEventListener('visibilitychange', record);
    document.addEventListener('prerenderingchange', record);
    record();
})();
