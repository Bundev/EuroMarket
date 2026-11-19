(() => {
    if (window.EuroMarketToast) return;
    const container = document.querySelector('[data-toast-container]');
    if (!container) return;
    const allowed = new Set(['success', 'error', 'warning', 'info']);
    const durations = { success: 5000, error: 12000, warning: 8000, info: 6000 };
    const icons = { success: '✓', error: '!', warning: '!', info: 'i' };
    const labels = { success: 'Готово', error: 'Ошибка', warning: 'Обратите внимание', info: 'Информация' };
    const queue = [], visible = new Set(), recent = new Map();
    let consumed;
    try { consumed = new Set(JSON.parse(sessionStorage.getItem('euromarket.toast.seen') || '[]')); }
    catch { consumed = new Set(); }
    function remember(id) {
        if (!id) return;
        consumed.add(id);
        while (consumed.size > 100) consumed.delete(consumed.values().next().value);
        try { sessionStorage.setItem('euromarket.toast.seen', JSON.stringify([...consumed])); } catch {}
    }
    function position() {
        const header = document.querySelector('.site-header');
        const bottom = header ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
        container.style.setProperty('--toast-top', Math.min(bottom + 12, window.innerHeight - 64) + 'px');
    }
    function pump() {
        while (visible.size < 3 && queue.length) mount(queue.shift());
    }
    function mount(item) {
        const returnFocus = document.activeElement;
        const node = document.createElement('section');
        node.className = 'em-toast em-toast-' + item.type;
        node.setAttribute('role', item.type === 'error' ? 'alert' : 'status');
        node.setAttribute('aria-live', item.type === 'error' ? 'assertive' : 'polite');
        node.setAttribute('aria-atomic', 'true');
        const icon = document.createElement('span'); icon.className = 'em-toast-icon'; icon.textContent = icons[item.type]; icon.setAttribute('aria-hidden', 'true');
        const content = document.createElement('div'); content.className = 'em-toast-content';
        const title = document.createElement('strong'); title.textContent = labels[item.type];
        const text = document.createElement('p'); text.textContent = item.message;
        content.append(title, text);
        if (item.action?.href === '/login') {
            const link = document.createElement('a'); link.href = '/login'; link.textContent = 'Войти в аккаунт'; content.append(link);
        }
        const close = document.createElement('button'); close.type = 'button'; close.className = 'em-toast-close'; close.textContent = '×'; close.setAttribute('aria-label', 'Закрыть уведомление');
        node.append(icon, content, close);
        visible.add(node); container.append(node); position();
        requestAnimationFrame(() => node.classList.add('is-visible'));
        let remaining = durations[item.type], started, timer, closing = false;
        const stop = () => { if (timer) { clearTimeout(timer); remaining = Math.max(0, remaining - (Date.now() - started)); timer = null; } };
        const start = () => { if (closing || node.matches(':hover') || node.contains(document.activeElement)) return; stop(); started = Date.now(); timer = setTimeout(remove, remaining); };
        function remove() {
            if (closing) return; closing = true; stop(); node.classList.remove('is-visible');
            setTimeout(() => {
                const focused = node.contains(document.activeElement);
                node.remove(); visible.delete(node); pump();
                if (focused) {
                    const target = container.querySelector('button') || (returnFocus?.isConnected ? returnFocus : document.querySelector('main a, main button'));
                    target?.focus();
                }
            }, 180);
        }
        close.addEventListener('click', remove);
        node.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); remove(); } });
        node.addEventListener('pointerenter', stop); node.addEventListener('pointerleave', start);
        node.addEventListener('focusin', stop); node.addEventListener('focusout', () => setTimeout(start, 0));
        start();
    }
    function show(message, type = 'info', options = {}) {
        if (typeof message !== 'string' || !message.trim()) return;
        type = allowed.has(type) ? type : 'info';
        if (options.id && consumed.has(options.id)) return;
        remember(options.id);
        const key = options.key || type + ':' + message;
        const now = Date.now();
        for (const [entry, time] of recent) if (now - time > 2000) recent.delete(entry);
        if (recent.has(key)) return;
        recent.set(key, now);
        if (queue.length >= 20) queue.shift();
        queue.push({ type, message: message.slice(0, 600), action: options.action }); pump();
    }
    window.EuroMarketToast = Object.freeze({ show });
    const seed = document.querySelector('[data-toast-seed]');
    seed?.content.querySelectorAll('[data-toast-id]').forEach(item => show(item.textContent, item.dataset.toastType, { id: item.dataset.toastId }));
    seed?.remove();
    const header = document.querySelector('.site-header');
    if (header && window.ResizeObserver) new ResizeObserver(position).observe(header);
    window.addEventListener('resize', position); position();
    window.addEventListener('pageshow', event => {
        if (event.persisted) { queue.length = 0; visible.forEach(node => node.remove()); visible.clear(); }
    });
})();
