(() => {
    const page = document.querySelector('[data-chat-id]');
    if (!page) return;
    const endpoint = '/api/messages/' + page.dataset.chatId;
    const history = page.querySelector('.chat-history');
    const older = page.querySelector('[data-chat-older]');
    const newMessages = page.querySelector('[data-chat-new]');
    const empty = page.querySelector('[data-chat-empty]');
    const status = page.querySelector('[data-chat-status]');
    const form = page.querySelector('.chat-compose');
    const token = document.querySelector('meta[name="favorites-csrf-token"]').content;
    const seen = new Set([...history.querySelectorAll('[data-message-id]')].map(item => Number(item.dataset.messageId)));
    let cursor = Math.max(0, ...seen);
    let loading = false;
    let pending = null;
    let lastRead = 0;
    let expired = false;

    async function api(url, body) {
        const response = await fetch(url, {
            method: body === undefined ? 'GET' : 'POST',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        const result = await response.json().catch(() => ({}));
        if (response.status === 401 || response.status === 403) expired = true;
        if (!response.ok) throw new Error(result.error || 'Обновите страницу и повторите действие.');
        return result;
    }

    function render(message) {
        if (seen.has(message.id)) return;
        seen.add(message.id);
        const article = document.createElement('article');
        article.className = 'chat-message' + (message.mine ? ' chat-message-mine' : '');
        article.dataset.messageId = message.id;
        article.dataset.mine = String(message.mine);
        const text = document.createElement('p');
        text.textContent = message.body;
        const meta = document.createElement('small');
        const time = document.createElement('time');
        time.textContent = new Date(message.createdAt).toLocaleString('ru-RU');
        meta.append(time);
        if (message.mine) {
            const receipt = document.createElement('span');
            receipt.dataset.receipt = '';
            receipt.textContent = message.readAt ? 'Прочитано' : 'Отправлено';
            meta.append(receipt);
        }
        article.append(text, meta);
        const next = [...history.children].find(item => Number(item.dataset.messageId) > message.id);
        history.insertBefore(article, next || null);
        empty.hidden = true;
    }

    async function markRead() {
        if (document.hidden) return;
        const upTo = Math.max(0, ...seen);
        if (upTo <= lastRead) return;
        const result = await api(endpoint + '/read', { up_to: upTo });
        lastRead = upTo;
        document.dispatchEvent(new CustomEvent('messages:unread', { detail: result.unread }));
    }

    async function refresh() {
        if (loading || document.hidden || expired) return;
        loading = true;
        const atBottom = history.scrollHeight - history.clientHeight - history.scrollTop < 80;
        try {
            let more;
            do {
                const result = await api(endpoint + '?after=' + cursor);
                const oldSize = seen.size;
                result.messages.forEach(render);
                for (const item of result.messages) cursor = Math.max(cursor, item.id);
                history.querySelectorAll('[data-mine="true"]').forEach(item => {
                    if (Number(item.dataset.messageId) <= result.readThrough) item.querySelector('[data-receipt]').textContent = 'Прочитано';
                });
                more = result.hasMore;
                if (seen.size > oldSize && !atBottom) newMessages.hidden = false;
            } while (more && !document.hidden);
            if (atBottom) history.scrollTop = history.scrollHeight;
            await markRead();
            status.textContent = '';
        } catch (error) {
            status.textContent = error.message || 'Нет связи. Повторяем загрузку…';
        } finally {
            loading = false;
        }
    }

    older.addEventListener('click', async () => {
        older.disabled = true;
        const height = history.scrollHeight;
        const top = history.scrollTop;
        try {
            const result = await api(endpoint + '?before=' + Math.min(...seen));
            result.messages.forEach(render);
            history.scrollTop = top + history.scrollHeight - height;
            older.hidden = !result.hasMore;
        } catch (error) {
            status.textContent = error.message;
        } finally {
            older.disabled = false;
        }
    });
    newMessages.addEventListener('click', () => {
        history.scrollTop = history.scrollHeight;
        newMessages.hidden = true;
    });

    if (form) {
        const textarea = form.querySelector('textarea');
        const button = form.querySelector('button');
        textarea.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                if (!button.disabled) form.requestSubmit();
            }
        });
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (button.disabled) return;
            const body = textarea.value.trim();
            if (!body) return;
            if (!pending || pending.body !== body) {
                const bytes = crypto.getRandomValues(new Uint8Array(16));
                const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
                pending = { body, client_key: hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20) };
            }
            button.disabled = true;
            textarea.disabled = true;
            button.textContent = 'Отправка…';
            try {
                const result = await api(endpoint, pending);
                render(result.message);
                textarea.value = '';
                pending = null;
                window.EuroMarketToast.show('Сообщение отправлено', 'success', { key: 'message-sent:' + result.message.id });
                history.scrollTop = history.scrollHeight;
                status.textContent = '';
                refresh();
            } catch (error) {
                status.textContent = '';
                window.EuroMarketToast.show(error.message || 'Не удалось отправить сообщение.', 'error');
            } finally {
                button.disabled = false;
                textarea.disabled = false;
                button.textContent = 'Отправить';
            }
        });
    }
    history.scrollTop = history.scrollHeight;
    refresh();
    setInterval(refresh, 5000);
    document.addEventListener('visibilitychange', refresh);
})();
