(() => {
    const storageKey = 'euromarket.listingView';
    let view = 'grid';
    try {
        if (localStorage.getItem(storageKey) === 'list') view = 'list';
    } catch (error) {
        // Переключение работает и при недоступном хранилище.
    }
    document.documentElement.dataset.listingView = view;

    document.addEventListener('DOMContentLoaded', () => {
        const buttons = [...document.querySelectorAll('[data-listing-view-button]')];
        function selectView(nextView) {
            document.documentElement.dataset.listingView = nextView;
            buttons.forEach(button => {
                const selected = button.dataset.listingViewButton === nextView;
                button.setAttribute('aria-pressed', String(selected));
                button.classList.toggle('active', selected);
            });
        }
        selectView(view);
        buttons.forEach(button => {
            button.addEventListener('click', () => {
                view = button.dataset.listingViewButton;
                selectView(view);
                try {
                    localStorage.setItem(storageKey, view);
                } catch (error) {
                    // Недоступность localStorage не блокирует интерфейс.
                }
            });
        });
    });
})();
