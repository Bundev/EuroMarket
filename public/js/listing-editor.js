(() => {
    const form = document.querySelector('[data-listing-editor]');
    if (!form) return;
    const sections = [...form.querySelectorAll('[data-editor-step]')];
    const byName = name => form.elements.namedItem(name);
    const category = byName('category_id');
    const country = byName('country_id');
    const city = byName('city_id');
    const files = byName('images');
    const gallery = form.querySelector('[data-editor-photos]');
    const bar = document.querySelector('.editor-progress');
    const tabs = [...bar.querySelectorAll('[data-editor-go]')];
    const back = form.querySelector('[data-editor-back]');
    const next = form.querySelector('[data-editor-next]');
    const save = form.querySelector('[data-editor-submit]');
    const publish = form.querySelector('[data-editor-publish]');
    const local = form.querySelector('[data-editor-local]');
    const status = document.querySelector('[data-editor-save-status]');
    const restore = document.querySelector('[data-editor-restore]');
    const error = form.querySelector('[data-editor-error]');
    const storageKey = 'euromarket.editor.' + form.dataset.draftKey;
    const version = form.dataset.version + ':' + form.dataset.status;
    const photos = [...gallery.children].map(item => ({ id: item.dataset.editorPhoto, src: item.querySelector('img').src }));
    const savedPhotos = new Map(photos.map(photo => [photo.id, photo]));
    const removedPhotos = [];
    const pick = form.querySelector('[data-editor-pick]');
    let dragIndex = null;
    const picker = typeof TomSelect === 'function' ? new TomSelect(city, {
        create: false, valueField: 'id', labelField: 'name', searchField: 'name', maxItems: 1
    }) : null;
    let step = 0, furthest = 0, dirty = false, saving = false, timer, cityRequest = 0, cityLoading = false;
    let changedElsewhere = false, restoring = false, lastCategory = category.value;
    let snapshot = readDraft();

    function readDraft() {
        try { return JSON.parse(localStorage.getItem(storageKey)); }
        catch { return null; }
    }

    function data() {
        return Object.fromEntries([...new FormData(form)].filter(([key, value]) =>
            typeof value === 'string' && key !== 'editor_version' && key !== 'photo_order'));
    }

    function saveLocal() {
        clearTimeout(timer);
        if (changedElsewhere) return;
        try {
            localStorage.setItem(storageKey, JSON.stringify({ version, fields: data(), step,
                photoIds: photos.filter(photo => photo.id).map(photo => photo.id),
                removedIds: removedPhotos.map(item => item.photo.id) }));
            status.textContent = 'Сохранено на этом устройстве' + (photos.some(photo => photo.file) ? ' · фото будут сохранены при отправке' : '');
        } catch { status.textContent = 'Ошибка сохранения на устройстве'; }
    }

    function changed() {
        if (restoring || saving) return;
        dirty = true;
        if (!changedElsewhere) {
            status.textContent = 'Сохранение на устройстве…';
            clearTimeout(timer);
            timer = setTimeout(saveLocal, 500);
        }
        updateActions();
    }

    function updateActions() {
        back.hidden = step === 0;
        next.hidden = step === sections.length - 1;
        save.hidden = step !== sections.length - 1;
        save.disabled = saving || cityLoading;
        if (publish) {
            publish.hidden = step !== sections.length - 1;
            publish.disabled = dirty || saving;
        }
    }

    function show(index, focus = true) {
        step = index;
        furthest = Math.max(furthest, index);
        sections.forEach((section, i) => { section.hidden = i !== index; });
        tabs.forEach((tab, i) => {
            tab.disabled = i > furthest;
            tab.classList.toggle('active', i === index);
            if (i === index) tab.setAttribute('aria-current', 'step');
            else tab.removeAttribute('aria-current');
        });
        bar.querySelector('[data-editor-progress]').textContent = 'Этап ' + (index + 1) + ' из ' + sections.length + ' · ' + tabs[index].querySelector('.editor-step-label').textContent;
        updateActions();
        if (index === sections.length - 1) preview();
        if (focus) sections[index].querySelector('h2').focus();
    }

    function invalid(field) {
        const index = sections.indexOf(field.closest('[data-editor-step]'));
        if (index >= 0) show(index, false);
        field.classList.add('is-invalid');
        field.setAttribute('aria-invalid', 'true');
        field.reportValidity();
        field.focus();
    }

    function validate(container) {
        const field = [...container.querySelectorAll('input, select, textarea')].find(input => input.willValidate && !input.validity.valid);
        if (!field) return true;
        invalid(field);
        return false;
    }

    const labelOf = select => select.selectedOptions[0]?.value ? select.selectedOptions[0].textContent.trim() : '';
    const currency = () => country.selectedOptions[0]?.dataset.currency || '';
    function counts() {
        form.querySelector('[data-editor-count="title"]').textContent = byName('title').value.length + ' / 200';
        form.querySelector('[data-editor-count="description"]').textContent = byName('description').value.length + ' симв.';
        form.querySelector('[data-editor-currency]').textContent = currency();
    }

    async function loadCities(desired = '') {
        const request = ++cityRequest;
        const note = form.querySelector('[data-editor-city-status]');
        const selectedCountry = country.value;
        cityLoading = Boolean(selectedCountry);
        updateActions();
        try {
            if (!selectedCountry) {
                if (picker) { picker.clear(true); picker.clearOptions(); }
                else city.replaceChildren(new Option('Выберите город', ''));
                return;
            }
            note.textContent = 'Загрузка городов…';
            const response = await fetch('/api/cities?country_id=' + encodeURIComponent(selectedCountry), { signal: AbortSignal.timeout(8000) });
            if (!response.ok) throw new Error('city-load');
            const cities = await response.json();
            if (request !== cityRequest) return;
            if (picker) {
                picker.clear(true); picker.clearOptions(); picker.addOptions(cities);
                if (desired) picker.setValue(desired, true);
            } else {
                city.replaceChildren(new Option('Выберите город', ''), ...cities.map(item => new Option(item.name, item.id)));
                city.value = desired;
            }
            note.textContent = desired && city.value !== desired ? 'Сохранённый город недоступен. Выберите другой.' : 'Город можно оставить пустым.';
        } catch {
            if (request === cityRequest) note.textContent = 'Список городов недоступен. Повторно выберите страну, чтобы загрузить его.';
        } finally {
            if (request === cityRequest) { cityLoading = false; updateActions(); }
        }
    }

    function photoImage(photo) {
        const image = document.createElement('img');
        image.src = photo.src;
        image.alt = 'Фотография объявления';
        return image;
    }

    const photoIcons = {
        left: 'M15 18l-6-6 6-6',
        right: 'M9 18l6-6-6-6',
        cover: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z',
        remove: 'M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5'
    };

    function photoButton(icon, label, callback, disabled = false) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn editor-photo-button editor-photo-button-' + icon;
        button.title = label;
        button.setAttribute('aria-label', label);
        button.disabled = disabled;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS(svg.namespaceURI, 'path');
        path.setAttribute('d', photoIcons[icon]);
        svg.append(path);
        button.append(svg);
        button.addEventListener('click', callback);
        return button;
    }

    function movePhoto(from, to) {
        if (from === to) return;
        photos.splice(to, 0, photos.splice(from, 1)[0]);
        renderPhotos();
        gallery.children[to]?.querySelector('button:not(:disabled)')?.focus();
        changed();
    }

    function removePhoto(index) {
        const photo = photos[index];
        if (!photo.file && !window.confirm('Убрать фотографию? Она будет удалена после сохранения объявления.')) return;
        photos.splice(index, 1);
        if (photo.file) URL.revokeObjectURL(photo.src);
        else removedPhotos.push({ photo, index });
        renderPhotos();
        (gallery.children[Math.min(index, photos.length - 1)]?.querySelector('button:not(:disabled)') || pick).focus();
        changed();
    }

    function renderPhotos() {
        const transfer = new DataTransfer();
        const order = [];
        let fileIndex = 0;
        gallery.replaceChildren();
        photos.forEach((photo, index) => {
            if (photo.file) { transfer.items.add(photo.file); order.push('new:' + fileIndex++); }
            else order.push('id:' + photo.id);
            const tile = document.createElement('li');
            tile.className = 'editor-photo' + (index ? '' : ' editor-photo-cover');
            tile.draggable = true;
            tile.addEventListener('dragstart', event => {
                if (event.target !== tile) return;
                dragIndex = index;
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', String(index));
                tile.classList.add('is-dragging');
            });
            tile.addEventListener('dragend', () => { dragIndex = null; tile.classList.remove('is-dragging', 'is-drop-target'); });
            tile.addEventListener('dragover', event => {
                if (dragIndex === null || dragIndex === index) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                tile.classList.add('is-drop-target');
            });
            tile.addEventListener('dragleave', event => { if (!tile.contains(event.relatedTarget)) tile.classList.remove('is-drop-target'); });
            tile.addEventListener('drop', event => {
                if (dragIndex === null) return;
                event.preventDefault();
                const from = dragIndex;
                dragIndex = null;
                movePhoto(from, index);
            });
            const title = document.createElement('span');
            title.className = 'editor-photo-label';
            title.textContent = index ? 'Фото ' + (index + 1) : 'Обложка';
            const image = photoImage(photo);
            image.draggable = false;
            const media = document.createElement('div');
            media.className = 'editor-photo-media';
            media.append(image, title);
            const buttons = document.createElement('div');
            buttons.className = 'editor-photo-actions';
            const provenance = document.createElement('span');
            provenance.className = 'editor-photo-provenance';
            provenance.textContent = photo.file ? 'Новое фото' : 'Сохранено';
            buttons.append(
                photoButton('left', 'Переместить фото ' + (index + 1) + ' влево', () => movePhoto(index, index - 1), index === 0),
                photoButton('right', 'Переместить фото ' + (index + 1) + ' вправо', () => movePhoto(index, index + 1), index === photos.length - 1),
                photoButton('cover', index ? 'Сделать главной фотографией ' + (index + 1) : 'Фотография уже выбрана обложкой',
                    () => movePhoto(index, 0), index === 0),
                photoButton('remove', 'Удалить фото ' + (index + 1), () => removePhoto(index))
            );
            tile.append(media, provenance, buttons);
            gallery.append(tile);
        });
        files.files = transfer.files;
        if (byName('photo_order')) byName('photo_order').value = [...order, ...removedPhotos.map(item => 'remove:' + item.photo.id)].join(',');
        form.querySelector('[data-editor-photo-count]').textContent = photos.length + ' из 10 фотографий';
        form.querySelector('[data-editor-photo-empty]').textContent = photos.length ? 'Фотографии объявления' : 'Покажите товар на фотографиях';
        pick.disabled = photos.length >= 10;
        form.querySelector('[data-editor-photo-removals]').hidden = !removedPhotos.length;
        form.querySelector('[data-editor-photo-removal-count]').textContent = 'Будут удалены после сохранения: ' + removedPhotos.length + '.';
    }

    function addPhotos(input) {
        const keys = new Set(photos.filter(item => item.file).map(item => fileKey(item.file)));
        const selected = [];
        let duplicates = 0;
        for (const file of input) {
            const key = fileKey(file);
            if (keys.has(key)) duplicates++;
            else { keys.add(key); selected.push(file); }
        }
        const alert = form.querySelector('[data-editor-photo-error]');
        const problem = photos.length + selected.length > 10 ? 'Можно добавить до 10 фотографий.' :
            selected.some(file => !['image/jpeg','image/png','image/webp'].includes(file.type)) ? 'Выберите JPEG, PNG или WebP.' :
            selected.some(file => file.size > 5 * 1024 * 1024) ? 'Размер каждой фотографии должен быть не больше 5 МБ.' : '';
        if (problem) {
            alert.textContent = problem;
            renderPhotos();
            return;
        }
        alert.textContent = duplicates ? 'Повторные файлы пропущены: ' + duplicates + '.' : '';
        photos.push(...selected.map(file => ({ file, src: URL.createObjectURL(file) })));
        renderPhotos();
        if (selected.length) changed();
    }

    const fileKey = file => JSON.stringify([file.name, file.size, file.lastModified, file.type]);

    function preview() {
        form.querySelector('[data-preview-title]').textContent = byName('title').value || 'Без названия';
        form.querySelector('[data-preview-price]').textContent = byName('price').value ?
            Number(byName('price').value).toLocaleString('ru-RU') + ' ' + currency() : 'Цена не указана';
        form.querySelector('[data-preview-location]').textContent = [labelOf(city), labelOf(country)].filter(Boolean).join(', ');
        form.querySelector('[data-preview-description]').textContent = byName('description').value;
        form.querySelector('[data-preview-images]').replaceChildren(...photos.map(photoImage));
        const specs = form.querySelector('[data-preview-attributes]');
        specs.replaceChildren();
        for (const field of form.querySelectorAll('[name^="attr_"]')) {
            if (!field.value) continue;
            const term = document.createElement('dt'), value = document.createElement('dd');
            term.textContent = field.labels[0]?.textContent || '';
            value.textContent = field.tagName === 'SELECT' ? field.selectedOptions[0]?.textContent : field.value;
            specs.append(term, value);
        }
    }

    category.addEventListener('change', event => {
        if (!restoring && category.value !== lastCategory && [...form.querySelectorAll('[name^="attr_"]')].some(field => field.value) &&
            !window.confirm('При смене категории несовместимые характеристики будут удалены. Продолжить?')) {
            category.value = lastCategory;
            event.stopImmediatePropagation();
            return;
        }
        lastCategory = category.value;
    }, true);
    country.addEventListener('change', () => {
        if (picker) { picker.clear(true); picker.clearOptions(); }
        else city.replaceChildren(new Option('Выберите город', ''));
        if (!restoring) void loadCities();
        counts();
    });
    form.addEventListener('input', event => {
        if (event.target === files) return;
        event.target.classList.remove('is-invalid');
        event.target.removeAttribute('aria-invalid');
        if (event.target.nextElementSibling?.matches('[data-editor-field-error]')) event.target.nextElementSibling.remove();
        counts(); changed();
    });
    form.addEventListener('change', event => { if (event.target !== files) changed(); });
    files.addEventListener('change', () => addPhotos(files.files));
    pick.addEventListener('click', () => files.click());
    form.querySelector('[data-editor-undo-photo]').addEventListener('click', () => {
        const last = removedPhotos.pop();
        if (!last) return;
        photos.splice(last.index, 0, last.photo);
        renderPhotos(); changed();
        gallery.children[Math.min(last.index, photos.length - 1)]?.querySelector('button:not(:disabled)')?.focus();
    });
    const zone = form.querySelector('[data-editor-drop]');
    zone.addEventListener('dragover', event => { event.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', event => { event.preventDefault(); zone.classList.remove('dragover'); addPhotos(event.dataTransfer.files); });
    tabs.forEach((tab, index) => tab.addEventListener('click', () => show(index)));
    back.addEventListener('click', () => show(step - 1));
    next.addEventListener('click', () => { if (validate(sections[step])) show(step + 1); });
    local.addEventListener('click', saveLocal);

    restore.addEventListener('click', async () => {
        snapshot = readDraft();
        if (!snapshot || snapshot.version !== version || !snapshot.fields) {
            status.textContent = 'Черновик относится к предыдущей версии объявления.';
            return;
        }
        restoring = true;
        changedElsewhere = false;
        for (const field of [category, country]) {
            if (typeof snapshot.fields[field.name] === 'string' && [...field.options].some(option => option.value === snapshot.fields[field.name])) {
                field.value = snapshot.fields[field.name];
                field.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
        for (const [name, value] of Object.entries(snapshot.fields)) {
            if (['category_id','country_id','city_id','attributes_form'].includes(name) || typeof value !== 'string') continue;
            const field = byName(name);
            if (field && field.type !== 'file') field.value = value;
        }
        await loadCities(String(snapshot.fields.city_id || ''));
        const removedIds = Array.isArray(snapshot.removedIds) ? snapshot.removedIds : [];
        const knownIds = Array.isArray(snapshot.photoIds) ? [...snapshot.photoIds, ...removedIds] : [];
        if (!photos.some(photo => photo.file) && knownIds.length === savedPhotos.size &&
            new Set(knownIds).size === savedPhotos.size && knownIds.every(id => savedPhotos.has(id))) {
            photos.splice(0, photos.length, ...snapshot.photoIds.map(id => savedPhotos.get(id)));
            removedPhotos.splice(0, removedPhotos.length, ...removedIds.map(id => ({ photo: savedPhotos.get(id), index: photos.length })));
            renderPhotos();
        }
        restoring = false;
        restore.hidden = true;
        counts(); changed();
        show(Math.max(0, Math.min(sections.length - 1, Number(snapshot.step) || 0)));
    });
    window.addEventListener('storage', event => {
        if (event.key !== storageKey) return;
        changedElsewhere = true;
        clearTimeout(timer);
        restore.hidden = readDraft()?.version !== version;
        status.textContent = 'Черновик изменён в другой вкладке.';
    });
    window.addEventListener('pagehide', () => { if (dirty && !saving) saveLocal(); });
    window.addEventListener('beforeunload', event => {
        if (!saving && photos.some(photo => photo.file)) { event.preventDefault(); event.returnValue = true; }
    });
    document.querySelectorAll('#editor-publish').forEach(action => action.addEventListener('submit', event => {
        if (dirty || saving) {
            event.preventDefault();
            window.EuroMarketToast.show('Сначала сохраните изменения объявления.', 'warning');
        }
    }));
    form.noValidate = true;
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (saving || restoring || cityLoading || !validate(form)) return;
        saving = true;
        clearTimeout(timer);
        updateActions();
        error.hidden = true;
        status.textContent = 'Сохранение объявления…';
        try {
            const response = await fetch(form.action, { method: 'POST', redirect: 'error', body: new FormData(form),
                headers: { Accept: 'application/json', 'X-CSRF-Token': document.querySelector('meta[name="favorites-csrf-token"]').content } });
            const result = response.headers.get('Content-Type')?.includes('application/json')
                ? await response.json() : { error: 'Не удалось сохранить объявление. Проверьте подключение и войдите в аккаунт.' };
            if (!response.ok) {
                let field = result.field && byName(result.field);
                if (!field && /фотограф|загруз/i.test(result.error || '')) show(3);
                if (!field && /категор|город|стран/i.test(result.error || '')) { show(0); }
                if (!field && /пол[ея] «/i.test(result.error || '')) show(2);
                if (field) {
                    show(sections.indexOf(field.closest('[data-editor-step]')), false);
                    field.classList.add('is-invalid'); field.setAttribute('aria-invalid', 'true');
                    if (field.nextElementSibling?.matches('[data-editor-field-error]')) field.nextElementSibling.remove();
                    const feedback = document.createElement('p');
                    feedback.className = 'text-danger small mb-1';
                    feedback.dataset.editorFieldError = '';
                    feedback.textContent = result.error;
                    field.after(feedback);
                    field.focus();
                }
                throw new Error(result.error || 'Не удалось сохранить объявление.');
            }
            const created = /^\/my-listings\?created=(\d+)$/.exec(result.redirect || '');
            const edit = /^\/listings\/\d+\/edit$/.test(result.redirect || '') ? result.redirect : null;
            if (!created && !edit) throw new Error('Не удалось подтвердить сохранение.');
            if (!changedElsewhere) try { localStorage.removeItem(storageKey); } catch { /* Storage may be unavailable. */ }
            dirty = false;
            status.textContent = 'Сохранено';
            location.assign((created ? '/listings/' + created[1] + '/edit' : edit) + '?step=preview');
        } catch (failure) {
            saving = false;
            status.textContent = 'Ошибка сохранения';
            error.textContent = failure.message === 'Failed to fetch' ? 'Соединение прервалось. Проверьте, сохранилось ли объявление, прежде чем отправить форму снова.' : failure.message;
            error.hidden = false;
            updateActions();
        }
    });

    restore.hidden = !snapshot || snapshot.version !== version;
    bar.hidden = false;
    local.hidden = false;
    renderPhotos();
    counts();
    if (country.value) void loadCities(city.value);
    show(new URLSearchParams(location.search).get('step') === 'preview' ? 4 : 0, false);
})();
