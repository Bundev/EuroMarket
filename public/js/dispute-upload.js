document.addEventListener('submit', async event => {
    const form = event.target;
    if (event.defaultPrevented || !form.matches('form[data-dispute-upload]')) return;
    event.preventDefault();
    const button = form.querySelector('button[type=submit]');
    if (button.disabled) return;
    const photos = form.elements.photos.files;
    if (photos.length > 5 || [...photos].some(photo => photo.size > 2 * 1024 * 1024)) {
        window.EuroMarketToast.show('Можно приложить до пяти фотографий, по 2 МБ каждая.', 'error');
        return;
    }
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Отправка…';
    try {
        const response = await fetch(form.action, {
            method: 'POST',
            redirect: 'error',
            headers: {
                Accept: 'application/json',
                'X-CSRF-Token': document.querySelector('meta[name="favorites-csrf-token"]').content
            },
            body: new FormData(form)
        });
        const result = await response.json();
        if (!response.ok) {
            window.EuroMarketToast.show(result.error || 'Не удалось открыть спор.', 'error');
        } else if (typeof result.redirect === 'string' && /^\/disputes\/[1-9]\d{0,9}$/.test(result.redirect)) {
            location.assign(result.redirect);
        } else {
            throw new Error('Unexpected dispute response');
        }
    } catch {
        window.EuroMarketToast.show('Не удалось отправить обращение. Обновите страницу и попробуйте снова.', 'error');
    } finally {
        button.disabled = false;
        button.textContent = label;
    }
});
