(() => {
    const countrySelect = document.getElementById('countrySelect');
    const citySelect = document.getElementById('citySelect');
    const priceCurrency = document.getElementById('priceCurrency');

    function updateCurrency() {
        const currency = countrySelect.selectedOptions[0]?.dataset.currency;
        priceCurrency.textContent = currency ? '(' + currency + ')' : '';
    }
    countrySelect.addEventListener('change', updateCurrency);
    updateCurrency();

    if (!countrySelect || !citySelect) return;

    const cityPicker = new TomSelect(citySelect, {
        create: false,
        maxItems: 1,
        valueField: 'id',
        labelField: 'name',
        searchField: ['name'],
        placeholder: 'Выберите город',
        sortField: {
            field: 'name',
            direction: 'asc'
        }
    });

    let requestId = 0;

    async function loadCities() {
        const currentRequest = ++requestId;
        const countryId = countrySelect.value;

        cityPicker.clear(true);
        cityPicker.clearOptions();
        cityPicker.disable();

        if (!countryId) {
            cityPicker.settings.placeholder = 'Сначала выберите страну';
            cityPicker.inputState();
            return;
        }

        cityPicker.settings.placeholder = 'Загрузка городов...';
        cityPicker.inputState();

        try {
            const response = await fetch(
                `/api/cities?country_id=${encodeURIComponent(countryId)}`
            );

            if (!response.ok) {
                throw new Error('Ошибка загрузки городов');
            }

            const cities = await response.json();

            // Игнорируем устаревший ответ, если страна изменилась
            if (currentRequest !== requestId) return;

            cityPicker.addOptions(cities);

            if (cities.length) {
                cityPicker.enable();
                cityPicker.settings.placeholder = 'Начните вводить город';
            } else {
                cityPicker.settings.placeholder = 'Города пока не добавлены';
            }

            cityPicker.inputState();

        } catch (error) {
            if (currentRequest !== requestId) return;

            console.error(error);
            cityPicker.settings.placeholder = 'Ошибка загрузки городов';
            cityPicker.inputState();
        }
    }

    countrySelect.addEventListener('change', loadCities);

    if (countrySelect.value) {
        loadCities();
    }
})();
