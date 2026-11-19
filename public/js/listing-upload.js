document.addEventListener('submit', async event => {
    const form = event.target;
    if (event.defaultPrevented || !form.matches('form[data-listing-upload]')) return;
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    if (button.disabled) return;
    const label = button.textContent;
    const data = new FormData(form);
    button.disabled = true;
    button.textContent = 'Загрузка…';
    try {
        const response = await fetch(form.action, {
            method: 'POST',
            redirect: 'error',
            headers: {
                Accept: 'application/json',
                'X-CSRF-Token': document.querySelector('meta[name="favorites-csrf-token"]').content
            },
            body: data
        });
        const result = await response.json();
        if (!response.ok) {
            window.EuroMarketToast.show(result.error || 'Не удалось сохранить объявление или фотографии.', 'error');
            return;
        }
        if (typeof result.redirect !== 'string' || !/^\/(?:my-listings(?:\?created=\d+)?|listings\/\d+\/edit)$/.test(result.redirect)) {
            throw new Error('Unexpected upload response');
        }
        location.assign(result.redirect);
    } catch {
        window.EuroMarketToast.show('Не удалось завершить загрузку. Обновите страницу и повторите попытку.', 'error');
    } finally {
        button.disabled = false;
        button.textContent = label;
    }
});
