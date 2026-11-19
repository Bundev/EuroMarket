(() => {
    const header = document.querySelector('.site-header');
    if (!header) return;
    const updateHeaderHeight = () => {
        document.documentElement.style.setProperty('--site-header-height', header.getBoundingClientRect().height + 'px');
    };
    new ResizeObserver(updateHeaderHeight).observe(header);
    updateHeaderHeight();
    const toggle = header.querySelector('.header-toggle');
    const panel = header.querySelector('.header-panel');
    const account = header.querySelector('details.header-account');
    const notifications = header.querySelector('.header-notifications');
    const country = header.querySelector('#headerCountry');
    const searchInput = header.querySelector('#headerSearch');
    const filterQuery = document.querySelector('[data-search-filter-query]');
    if (filterQuery) {
        searchInput.addEventListener('input', () => { filterQuery.value = searchInput.value; });
        searchInput.form.addEventListener('submit', event => {
            event.preventDefault();
            filterQuery.value = searchInput.value;
            filterQuery.form.requestSubmit();
        });
    }
    const desktop = window.matchMedia('(min-width: 992px)');

    function closeMenu() {
        panel.hidden = !desktop.matches;
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', 'Открыть меню');
        if (account) account.open = false;
    }

    toggle.addEventListener('click', () => {
        notifications.open = false;
        const open = toggle.getAttribute('aria-expanded') !== 'true';
        panel.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        toggle.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
        if (account) account.open = open;
    });
    country.addEventListener('change', () => country.form.requestSubmit());
    account?.addEventListener('focusout', event => {
        if (desktop.matches && !account.contains(event.relatedTarget)) account.open = false;
    });
    document.addEventListener('click', event => {
        if (!notifications.contains(event.target)) notifications.open = false;
        const outsideMobileMenu = !desktop.matches &&
            !panel.contains(event.target) && !toggle.contains(event.target);
        if (!header.contains(event.target) || outsideMobileMenu) closeMenu();
        else if (desktop.matches && account && !account.contains(event.target)) account.open = false;
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        const mobileOpen = toggle.getAttribute('aria-expanded') === 'true';
        const accountOpen = account?.open;
        const notificationsOpen = notifications.open;
        notifications.open = false;
        closeMenu();
        if (notificationsOpen) notifications.querySelector('summary').focus();
        else if (mobileOpen) toggle.focus();
        else if (accountOpen) account.querySelector('summary').focus();
    });
    desktop.addEventListener('change', () => {
        const panelHadFocus = panel.contains(document.activeElement);
        const toggleHadFocus = document.activeElement === toggle;
        closeMenu();
        notifications.open = false;
        if (!desktop.matches && panelHadFocus) toggle.focus();
        else if (desktop.matches && toggleHadFocus) country.focus();
    });
    closeMenu();
})();
