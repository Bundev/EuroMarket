(() => {
    const zone = document.getElementById('createUploadZone');
    const input = document.getElementById('createListingImages');
    const preview = document.getElementById('createImagesPreview');
    const count = document.getElementById('createUploadCount');

    const maxFiles = 10;
    const maxSize = 5 * 1024 * 1024;

    const allowedTypes = [
        'image/jpeg',
        'image/png',
        'image/webp'
    ];

    let previewUrls = [];

    function clearPreview() {
        previewUrls.forEach(url => URL.revokeObjectURL(url));
        previewUrls = [];
        preview.innerHTML = '';
    }

    function updateFiles(files) {
        const selected = Array.from(files);

        if (selected.length > maxFiles) {
            window.EuroMarketToast.show('Можно выбрать максимум 10 фотографий', 'warning');
            return;
        }

        for (const file of selected) {
            if (!allowedTypes.includes(file.type)) {
                window.EuroMarketToast.show('Разрешены только JPG, PNG и WebP', 'warning');
                return;
            }

            if (file.size > maxSize) {
                window.EuroMarketToast.show('Размер фотографии не должен превышать 5 МБ', 'warning');
                return;
            }
        }

        const transfer = new DataTransfer();

        selected.forEach(file => {
            transfer.items.add(file);
        });

        input.files = transfer.files;

        clearPreview();

        selected.forEach(file => {
            const url = URL.createObjectURL(file);
            previewUrls.push(url);

            const col = document.createElement('div');
            col.className = 'col-4 col-md-3';

            const img = document.createElement('img');
            img.src = url;
            img.alt = file.name;
            img.className = 'listing-new-preview';

            col.appendChild(img);
            preview.appendChild(col);
        });

        count.textContent = `${selected.length} выбрано`;
    }

    zone.addEventListener('click', () => input.click());

    zone.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            input.click();
        }
    });

    input.addEventListener('change', () => {
        updateFiles(input.files);
    });

    zone.addEventListener('dragover', event => {
        event.preventDefault();
        zone.classList.add('dragover');
    });

    zone.addEventListener('dragleave', () => {
        zone.classList.remove('dragover');
    });

    zone.addEventListener('drop', event => {
        event.preventDefault();
        zone.classList.remove('dragover');
        updateFiles(event.dataTransfer.files);
    });

    window.addEventListener('pagehide', clearPreview);
})();
