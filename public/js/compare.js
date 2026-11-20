(() => {
    const key = 'euromarket.compare';
    let ids = [];
    try {
        const saved = JSON.parse(localStorage.getItem(key));
        if (Array.isArray(saved)) ids = [...new Set(saved.filter(id => typeof id === 'string' && /^[1-9]\d{0,9}$/.test(id)))].slice(0, 4);
    } catch { /* Storage can be unavailable. */ }

    const buttons = [...document.querySelectorAll('[data-compare-id]')];
    const links = [...document.querySelectorAll('a[href="/compare"]')];
    const page = document.querySelector('[data-compare-page]');
    const header = document.querySelector('[data-header-compare]');
    const count = header?.querySelector('[data-compare-count]');
    const url = ids => ids.length ? '/compare?ids=' + ids.join(',') : '/compare';
    if (page && !location.search && ids.length) {
        location.replace(url(ids));
        return;
    }
    if (page && location.search) {
        ids = [...document.querySelectorAll('[data-remove-comparison]')].map(button => button.dataset.removeComparison);
        save();
    }

    function save() {
        try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* Apply to this page. */ }
    }

    function render() {
        buttons.forEach(button => {
            const selected = ids.includes(button.dataset.compareId);
            button.setAttribute('aria-pressed', String(selected));
            button.querySelector('[data-compare-label]').textContent = selected ? 'В сравнении' : 'Сравнить';
            button.hidden = false;
        });
        links.forEach(link => { link.href = url(ids); });
        if (count) {
            count.textContent = ids.length || '';
            count.hidden = ids.length === 0;
            header.setAttribute('aria-label', ids.length ? 'Сравнение, выбрано ' + ids.length + ' из 4' : 'Сравнение');
        }
    }

    buttons.forEach(button => button.addEventListener('click', () => {
        const id = button.dataset.compareId;
        if (ids.includes(id)) ids = ids.filter(item => item !== id);
        else if (ids.length < 4) ids.push(id);
        else {
            window.EuroMarketToast.show('Можно сравнить до четырёх объявлений.', 'warning');
            return;
        }
        save();
        render();
    }));
    document.querySelectorAll('[data-remove-comparison]').forEach(button => button.addEventListener('click', () => {
        ids = ids.filter(id => id !== button.dataset.removeComparison);
        save();
        location.replace(url(ids));
    }));
    page?.querySelector('[data-compare-clear]')?.addEventListener('click', () => {
        if (!window.confirm('Очистить список сравнения?')) return;
        ids = [];
        save();
        render();
        location.replace('/compare');
    });
    const differences = page?.querySelector('[data-compare-differences]');
    differences?.addEventListener('change', () => {
        page.querySelectorAll('[data-compare-same]').forEach(row => { row.hidden = differences.checked; });
        page.querySelector('[data-compare-no-differences]').hidden =
            !differences.checked || Boolean(page.querySelector('.compare-difference'));
    });
    render();
})();
