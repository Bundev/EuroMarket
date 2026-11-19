(() => {
    const listingId = document.currentScript.dataset.listingId;
    const token = document.querySelector('meta[name="favorites-csrf-token"]')?.content;
    if (!token) return;

    let recorded = false;
    function recordVisibleView() {
        if (recorded || document.visibilityState !== 'visible' || document.prerendering) return;
        recorded = true;
        fetch('/api/recently-viewed/' + encodeURIComponent(listingId), {
            method: 'POST',
            headers: { 'X-CSRF-Token': token },
            keepalive: true
        }).catch(() => {});
    }

    document.addEventListener('visibilitychange', recordVisibleView);
    document.addEventListener('prerenderingchange', recordVisibleView);
    window.addEventListener('pageshow', event => {
        if (event.persisted) recorded = false;
        recordVisibleView();
    });
    recordVisibleView();
})();
