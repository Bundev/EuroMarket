(() => {
    const country = document.getElementById('searchCountry');
    const city = document.getElementById('searchCity');

    if (!country || !city) return;

    const initialCity = city.dataset.selectedCity;
    let requestId = 0;

    async function loadCities(selectedCity = '') {
        const currentRequest = ++requestId;
        const countryId = country.value;

        city.disabled = true;
        city.innerHTML = '<option value="">Все города</option>';

        if (!countryId) return;

        try {
            const response = await fetch(
                `/api/cities?country_id=${encodeURIComponent(countryId)}`
            );

            if (!response.ok) throw new Error('Ошибка загрузки');

            const cities = await response.json();

            if (currentRequest !== requestId) return;

            cities.forEach(item => {
                city.add(new Option(item.name, item.id));
            });

            city.disabled = false;

            if (selectedCity) {
                city.value = selectedCity;
            }

        } catch (error) {
            console.error(error);
            city.innerHTML =
                '<option value="">Ошибка загрузки городов</option>';
        }
    }

    country.addEventListener('change', () => loadCities());
    loadCities(initialCity);
})();
