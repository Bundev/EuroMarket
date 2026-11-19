(() => {
    const token = document.querySelector('meta[name="favorites-csrf-token"]')?.content;
    document.querySelectorAll('[data-favorite-id]').forEach(button => {
        button.addEventListener('click', async () => {
            const id = button.dataset.favoriteId;
            const adding = button.getAttribute('aria-pressed') !== 'true';
            const buttons = [...document.querySelectorAll('[data-favorite-id]')]
                .filter(item => item.dataset.favoriteId === id);
            buttons.forEach(item => { item.disabled = true; });
            try {
                const response = await fetch('/api/favorites/' + encodeURIComponent(id), {
                    method: adding ? 'PUT' : 'DELETE',
                    credentials: 'same-origin',
                    headers: { 'X-CSRF-Token': token || '' }
                });
                const result = await response.json();
                if (!response.ok) {
                    window.EuroMarketToast.show(result.error || 'Не удалось изменить избранное.', 'error', { action: response.status === 401 ? { href: '/login' } : undefined });
                    return;
                }
                buttons.forEach(item => {
                    item.setAttribute('aria-pressed', String(result.isFavorite));
                    const label = result.isFavorite ? 'Удалить из избранного' : 'Добавить в избранное';
                    item.setAttribute('aria-label', label);
                    item.title = label;
                });
                if (!result.isFavorite && document.querySelector('[data-favorites-page]')) {
                    button.closest('.search-listing-card')?.remove();
                    const total = document.getElementById('searchTotal');
                    if (total) total.textContent = String(Math.max(0, Number(total.textContent) - 1));
                    if (!document.querySelector('.search-listing-card')) {
                        const results = document.querySelector('.search-results-list');
                        if (results) results.textContent = 'На этой странице больше нет объявлений. Перейдите на другую страницу или обновите список.';
                    }
                }
                window.EuroMarketToast.show(result.isFavorite ? 'Добавлено в избранное' : 'Удалено из избранного', 'success');
            } catch (error) {
                window.EuroMarketToast.show('Не удалось связаться с сервером. Повторите попытку.', 'error');
            } finally {
                buttons.forEach(item => { item.disabled = false; });
            }
        });
    });
})();
