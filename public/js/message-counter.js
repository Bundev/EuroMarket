(() => {
    function update(count) {
        if (!Number.isFinite(count)) return;
        document.querySelectorAll('[data-message-unread]').forEach(badge => {
            badge.textContent = count > 99 ? '99+' : String(count);
            badge.hidden = count <= 0;
            badge.parentElement.setAttribute('aria-label', count > 0 ? 'Сообщения, непрочитанных: ' + count : 'Сообщения');
        });
    }
    document.addEventListener('messages:unread', event => update(event.detail));
    if (!document.querySelector('[data-poll-messages]')) return;
    let loading = false;
    async function refresh() {
        if (document.hidden || loading) return;
        loading = true;
        try {
            const response = await fetch('/api/messages/unread', { cache: 'no-store' });
            if (response.ok) {
                const counts = await response.json();
                update(counts.unread);
                document.dispatchEvent(new CustomEvent('notifications:count', { detail: counts.notifications }));
            }
        } catch (error) {
            // При временной потере сети сохраняем последний счётчик.
        } finally {
            loading = false;
        }
    }
    refresh();
    setInterval(refresh, 20000);
    document.addEventListener('visibilitychange', refresh);
})();
