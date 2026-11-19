(() => {
    const form = document.getElementById('listingUploadForm');
    const zone = document.getElementById('listingUploadZone');
    const input = document.getElementById('newListingImages');
    const preview = document.getElementById('newImagesPreview');
    const count = document.getElementById('uploadCount');
    const button = document.getElementById('uploadImagesButton');

    if (!form || !zone || !input) return;

    const existingCount = Number(form.dataset.existingCount);
    const maxFiles = Math.max(0, 10 - existingCount);
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
            window.EuroMarketToast.show(`Можно добавить ещё максимум ${maxFiles} фото`, 'warning');
            return;
        }

        for (const file of selected) {
            if (!allowedTypes.includes(file.type) ||
                file.size > maxSize) {
                window.EuroMarketToast.show('Разрешены JPG, PNG, WebP до 5 МБ', 'warning');
                return;
            }
        }

        const transfer = new DataTransfer();
        selected.forEach(file => transfer.items.add(file));
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
        button.disabled = selected.length === 0;
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

    form.addEventListener('submit', event => {
        if (!input.files.length || input.files.length > maxFiles) {
            event.preventDefault();
            return;
        }
    });

    if (maxFiles === 0) {
        zone.style.display = 'none';
        button.disabled = true;
        count.textContent = 'Достигнут лимит: 10 фото';
    }

    window.addEventListener('pagehide', clearPreview);
})();
