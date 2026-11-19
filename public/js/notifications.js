(() => {
    const dropdown = document.querySelector('.header-notifications');
    const latest = document.querySelector('[data-notification-latest]');
    const token = document.querySelector('meta[name="favorites-csrf-token"]').content;
    let loading = false;
    let revision = 0;
    function counter(count) {
        if (!Number.isFinite(count)) return;
        document.querySelectorAll('[data-notification-count]').forEach(badge => {
            badge.textContent = count > 99 ? '99+' : String(count);
            badge.hidden = count === 0;
        });
    }
    function error(message) {
        document.querySelectorAll('[data-notification-error]').forEach(item => { item.textContent = message; });
    }
    async function api(url, body) {
        const response = await fetch(url, {
            method: body === undefined ? 'GET' : 'POST',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || (response.status === 401 ? 'Войдите в аккаунт, чтобы открыть уведомления.' : 'Не удалось обновить уведомления.'));
        return data;
    }
    async function load() {
        if (loading) return;
        loading = true;
        const version = revision;
        error('Загрузка…');
        try {
            const data = await api('/api/notifications');
            if (version !== revision) return;
            counter(data.unread);
            latest.replaceChildren();
            if (!data.items.length) latest.textContent = 'Уведомлений пока нет.';
            data.items.forEach(item => {
                const row = document.createElement('article');
                row.className = 'notification-item' + (item.read_at ? '' : ' notification-unread');
                row.dataset.notificationId = item.id;
                const link = document.createElement('a');
                link.href = '/notifications/' + item.id + '/open';
                link.dataset.notificationOpen = item.id;
                link.textContent = item.text;
                const date = document.createElement('div');
                date.className = 'small text-muted';
                date.textContent = new Date(item.created_at).toLocaleString('ru-RU');
                row.append(link, date);
                if (!item.read_at) {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'btn btn-sm btn-link';
                    button.dataset.notificationRead = item.id;
                    button.textContent = 'Отметить прочитанным';
                    row.append(button);
                }
                latest.append(row);
            });
            error('');
        } catch (cause) { error(cause.message); }
        finally { loading = false; }
    }
    function markRows(id = null, upTo = Infinity) {
        document.querySelectorAll('[data-notification-id]').forEach(row => {
            if (id !== null && row.dataset.notificationId !== id) return;
            if (Number(row.dataset.notificationId) > upTo) return;
            row.classList.remove('notification-unread');
            row.querySelector('[data-notification-read]')?.remove();
        });
    }
    document.addEventListener('click', async event => {
        const read = event.target.closest('[data-notification-read]');
        const all = event.target.closest('[data-notification-read-all]');
        const link = event.target.closest('[data-notification-open]');
        if (!read && !all && !link) return;
        if (link && (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0)) return;
        event.preventDefault();
        const button = read || all;
        if (button?.disabled) return;
        if (button) button.disabled = true;
        try {
            let data;
            if (all) {
                const snapshot = await api('/api/notifications');
                if (!snapshot.items.length) { counter(snapshot.unread); return; }
                data = await api('/api/notifications/read-all', { up_to: snapshot.items[0].id });
                revision++;
                markRows(null, Number(snapshot.items[0].id));
            } else {
                const id = read ? read.dataset.notificationRead : link.dataset.notificationOpen;
                data = await api('/api/notifications/' + id + '/read', {});
                revision++;
                markRows(id);
            }
            counter(data.unread);
            error('');
            if (link) window.location.assign(link.href);
        } catch (cause) { error(cause.message); }
        finally { if (button) button.disabled = false; }
    });
    dropdown.addEventListener('toggle', () => { if (dropdown.open) load(); });
    document.addEventListener('notifications:count', event => {
        counter(event.detail);
        if (dropdown.open) load();
    });
})();
