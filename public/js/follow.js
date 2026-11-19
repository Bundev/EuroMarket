(() => {
    const token = document.querySelector('meta[name="favorites-csrf-token"]')?.content;
    document.querySelectorAll('[data-follow-seller]').forEach(button => {
        button.addEventListener('click', async () => {
            if (button.disabled) return;
            button.disabled = true;
            try {
                const response = await fetch('/api/following/' + encodeURIComponent(button.dataset.followSeller), {
                    method: button.getAttribute('aria-pressed') === 'true' ? 'DELETE' : 'PUT',
                    headers: { 'X-CSRF-Token': token || '', Accept: 'application/json' }
                });
                const result = await response.json();
                if (!response.ok) {
                    window.EuroMarketToast.show(result.error || 'Не удалось изменить подписку.', 'error', {
                        action: response.status === 401 ? { href: '/login' } : undefined
                    });
                    return;
                }
                button.setAttribute('aria-pressed', String(result.following));
                button.textContent = result.following ? button.dataset.followingLabel : button.dataset.followLabel;
                button.title = result.following ? 'Отписаться от продавца' : 'Подписаться на продавца';
                button.classList.toggle('btn-primary', !result.following);
                button.classList.toggle('btn-outline-primary', result.following);
                const count = document.querySelector('[data-follower-count]');
                if (count) count.textContent = result.total;
                const list = button.closest('[data-following-list]');
                if (list && !result.following) {
                    const row = button.closest('li');
                    const next = row.nextElementSibling || row.previousElementSibling;
                    row.remove();
                    if (next) next.querySelector('button').focus();
                    else document.querySelector('[data-follow-empty]').hidden = false;
                }
                window.EuroMarketToast.show(result.following ? 'Подписка оформлена' : 'Подписка отменена', 'success');
            } catch {
                window.EuroMarketToast.show('Не удалось изменить подписку. Повторите попытку.', 'error');
            } finally {
                button.disabled = false;
            }
        });
    });
})();
