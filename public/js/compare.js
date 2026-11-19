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
            button.textContent = selected ? 'В сравнении' : 'Сравнить';
            button.hidden = false;
        });
        links.forEach(link => { link.href = url(ids); });
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
    render();
})();
