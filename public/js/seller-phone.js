(() => {
    const button = document.querySelector('[data-phone-listing]');
    const result = document.querySelector('.seller-phone-result');
    if (!button || !result) return;
    button.addEventListener('click', async () => {
        button.disabled = true;
        result.textContent = 'Загрузка контакта…';
        try {
            const response = await fetch('/api/listings/' + encodeURIComponent(button.dataset.phoneListing) + '/phone', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'X-CSRF-Token': document.querySelector('meta[name="favorites-csrf-token"]').content }
            });
            if (response.status === 404) {
                result.textContent = 'Продавец не опубликовал телефон или объявление больше недоступно.';
                return;
            }
            if (response.status === 429) {
                result.textContent = 'Слишком много запросов. Попробуйте позже.';
                return;
            }
            if (!response.ok) throw new Error('Contact unavailable');
            const { phone } = await response.json();
            const link = document.createElement('a');
            link.href = 'tel:' + phone;
            link.textContent = phone;
            link.className = 'fw-semibold';
            result.replaceChildren(link);
            button.hidden = true;
        } catch (error) {
            result.textContent = 'Не удалось загрузить контакт. Обновите страницу или повторите попытку.';
        } finally {
            button.disabled = false;
        }
    });
})();
