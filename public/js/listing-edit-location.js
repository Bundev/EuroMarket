(() => {
    const countrySelect = document.getElementById('countrySelect');
    const citySelect = document.getElementById('citySelect');
    const priceCurrency = document.getElementById('priceCurrency');
    const countryPriceWarning = document.getElementById('countryPriceWarning');
    const initialCountry = countrySelect.value;

    function updateCurrency() {
        const currency = countrySelect.selectedOptions[0]?.dataset.currency;
        priceCurrency.textContent = currency ? '(' + currency + ')' : '';
        countryPriceWarning.classList.toggle('text-warning', countrySelect.value !== initialCountry);
    }
    countrySelect.addEventListener('change', updateCurrency);
    updateCurrency();

    if (!countrySelect || !citySelect) return;

    const initialCity = citySelect.dataset.selectedCity;

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
    let firstLoad = true;

    async function loadCities() {
        const currentRequest = ++requestId;
        const countryId = countrySelect.value;

        cityPicker.clear(true);
        cityPicker.clearOptions();
        cityPicker.disable();

        if (!countryId) return;

        try {
            const response = await fetch(
                `/api/cities?country_id=${encodeURIComponent(countryId)}`
            );

            if (!response.ok) {
                throw new Error('Ошибка загрузки городов');
            }

            const cities = await response.json();

            if (currentRequest !== requestId) return;

            cityPicker.addOptions(cities);

            if (cities.length) {
                cityPicker.enable();
            }

            if (firstLoad && initialCity) {
                cityPicker.setValue(initialCity, true);
            }

            firstLoad = false;

        } catch (error) {
            console.error(error);
        }
    }

    countrySelect.addEventListener('change', () => {
        firstLoad = false;
        loadCities();
    });

    loadCities();
})();
