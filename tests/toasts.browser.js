(() => {
    const show = window.EuroMarketToast.show;
    document.querySelector('[data-demo="all"]').addEventListener('click', () => {
        show('Изменения объявления сохранены.', 'success');
        show('Не удалось сохранить изменения. Проверьте соединение и повторите попытку.', 'error');
        show('Перед публикацией проверьте цену и выбранную страну.', 'warning');
        show('Сообщение об информации из очереди.', 'info');
    });
    document.querySelector('[data-demo="single"]').addEventListener('click', () => show('Не удалось сохранить изменения. Проверьте соединение и повторите попытку.', 'error'));
    document.querySelector('[data-demo="xss"]').addEventListener('click', () => {
        show('Текст <img src=x onerror="alert(1)"> отображается безопасно.', 'info');
        show('Текст <img src=x onerror="alert(1)"> отображается безопасно.', 'info');
    });
    document.querySelector('[data-demo="tests"]').addEventListener('click', async () => {
        const output = document.querySelector('[data-demo-result]');
        const results = [];
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const dismiss = async () => {
            for (let i = 0; i < 30; i++) {
                const buttons = [...document.querySelectorAll('.em-toast-close')];
                if (!buttons.length) break;
                buttons.forEach(button => button.click()); await wait(200);
            }
        };
        await dismiss();
        show('Проверка безопасного текста <img src=x onerror="alert(1)">', 'info');
        show('Проверка безопасного текста <img src=x onerror="alert(1)">', 'info');
        await wait(220);
        results.push(['escaping/deduplication', document.querySelectorAll('.em-toast').length === 1 && !document.querySelector('.em-toast img')]);
        await dismiss();
        show('Тест времени успеха', 'success'); show('Тест времени ошибки', 'error'); show('Тест warning', 'warning'); show('Тест очереди', 'info');
        await wait(250);
        results.push(['max 3 / roles', document.querySelectorAll('.em-toast').length === 3 && document.querySelector('.em-toast-error')?.getAttribute('role') === 'alert' && document.querySelector('.em-toast-success')?.getAttribute('role') === 'status']);
        const button = document.querySelector('.em-toast-success button'); button.focus();
        await wait(5400);
        results.push(['focus pauses timer', Boolean(document.querySelector('.em-toast-success'))]);
        button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(220);
        results.push(['Escape closes / queue', !document.querySelector('.em-toast-success') && Boolean(document.querySelector('.em-toast-info'))]);
        await dismiss();
        show('Тест автоисчезновения', 'success'); show('Ошибка читается дольше', 'error');
        document.querySelector('[data-demo="tests"]').focus(); await wait(5500);
        results.push(['success 5 sec / error longer', !document.querySelector('.em-toast-success') && Boolean(document.querySelector('.em-toast-error'))]);
        const toast = document.querySelector('.em-toast');
        const header = document.querySelector('.site-header');
        results.push(['below header / no overflow', toast.getBoundingClientRect().top >= header.getBoundingClientRect().bottom && document.documentElement.scrollWidth <= innerWidth]);
        await dismiss();
        output.textContent = results.map(([name, okay]) => (okay ? 'PASS ' : 'FAIL ') + name).join(' | ');
        output.dataset.passed = String(results.every(([, okay]) => okay));
    });
})();
