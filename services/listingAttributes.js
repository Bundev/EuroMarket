const conditionChoices = [
    { code: 'new', label: 'Новое', hint: 'Товар не использовался.', aliases: ['Новое'] },
    { code: 'like_new', label: 'Как новое', hint: 'Почти без следов использования.', aliases: ['Как новое', 'Like new'] },
    { code: 'good', label: 'Хорошее', hint: 'Исправен, есть небольшие следы использования.', aliases: ['Хорошее'] },
    { code: 'fair', label: 'Удовлетворительное', hint: 'Работает, но есть заметный износ или дефекты.', aliases: ['Удовлетворительное'] },
    { code: 'parts', label: 'На запчасти / неисправное', hint: 'Товар не работает или продаётся на детали.', aliases: ['На запчасти / неисправное'] },
    { code: 'repair', label: 'Требует ремонта', hint: 'Укажите, какой ремонт необходим.', aliases: ['Требует ремонта'] }
];
const condition = { key: 'condition', label: 'Состояние товара', type: 'enum',
    options: conditionChoices.filter(option => option.code !== 'repair') };
const vehicleCondition = { ...condition, label: 'Состояние автомобиля',
    options: conditionChoices.filter(option => ['new','good','repair'].includes(option.code)) };
const text = (key, label) => ({ key, label, type: 'text' });
const choice = (key, label, options) => ({ key, label, type: 'enum', options });
const number = (key, label, unit, min, max, decimals = 0) => ({ key, label, type: 'number', unit, min, max, decimals });

const profiles = {
    vehicles: { inherit: true, fields: [
        text('car_brand', 'Марка'), text('car_model', 'Модель'),
        number('car_year', 'Год выпуска', '', 1886, 2100), number('car_mileage', 'Пробег', 'км', 0, 10000000),
        choice('car_fuel', 'Топливо', ['Бензин', 'Дизель', 'Газ', 'Гибрид', 'Электро', 'Другое']),
        choice('car_gearbox', 'Коробка передач', ['Механическая', 'Автоматическая', 'Робот', 'Вариатор']), vehicleCondition
    ] },
    electronics: { inherit: true, fields: [
        text('device_brand', 'Бренд'), text('device_model', 'Модель'),
        number('device_storage', 'Память', 'ГБ', 1, 1000000), text('device_color', 'Цвет'), condition,
        choice('device_warranty', 'Гарантия', ['Есть', 'Нет'])
    ] },
    'real-estate': { inherit: true, fields: [
        choice('property_type', 'Тип недвижимости', ['Квартира', 'Дом', 'Комната', 'Коммерческая', 'Участок', 'Другое']),
        number('property_area', 'Площадь', 'м²', 0.01, 100000000, 2),
        number('property_rooms', 'Комнаты', '', 0, 1000), number('property_floor', 'Этаж', '', -10, 250),
        choice('property_condition', 'Состояние', ['С ремонтом', 'Без ремонта', 'Требует ремонта'])
    ] }
};

const fieldsByKey = new Map(Object.values(profiles).flatMap(profile => profile.fields.map(field => [field.key, field])));
const prefix = 'attr_';
const defaultFields = [condition];

function conditionOption(value, field = { options: conditionChoices }) {
    return field.options.find(option => option.code === value || option.aliases?.includes(value));
}

function fieldsFor(categoryId, categories) {
    const byId = new Map(categories.map(category => [Number(category.id), category]));
    const visited = new Set();
    let current = byId.get(Number(categoryId));
    while (current && !visited.has(current.id)) {
        visited.add(current.id);
        const profile = Object.hasOwn(profiles, current.slug) && profiles[current.slug];
        if (profile && (profile.inherit || Number(current.id) === Number(categoryId))) return profile.fields;
        current = byId.get(Number(current.parent_id));
    }
    return byId.has(Number(categoryId)) ? defaultFields : [];
}

function groups(categories) {
    const result = new Map();
    for (const category of categories) {
        const fields = fieldsFor(category.id, categories);
        if (!fields.length) continue;
        if (!result.has(fields)) result.set(fields, []);
        result.get(fields).push(category.id);
    }
    return [...result].map(([fields, ids]) => ({ fields, ids }));
}

function normalized(field, value) {
    if (typeof value !== 'string') throw new Error('Некорректное значение поля «' + field.label + '».');
    const input = value.trim();
    if (!input) return null;
    if (field.type === 'number') {
        const pattern = field.decimals ? /^-?\d{1,10}(?:[.,]\d{1,2})?$/ : /^-?\d{1,10}$/;
        const parsed = Number(input.replace(',', '.'));
        if (pattern.test(input) && parsed >= field.min && parsed <= field.max) return parsed;
    } else if (field.key === 'condition') {
        const option = conditionOption(input, field);
        if (option) return option.code;
    } else if (field.type === 'enum' ? field.options.includes(input) : input.length <= 100) return input;
    throw new Error('Некорректное значение поля «' + field.label + '».');
}

function listingValues(fields, input) {
    if (input.attributes_form !== '1' && input.item_condition === undefined && !Object.keys(input).some(key => key.startsWith(prefix))) return undefined;
    const values = new Map();
    for (const field of fields) {
        try {
            const value = normalized(field, input[prefix + field.key] ?? (field.key === 'condition' ? input.item_condition : '') ?? '');
            if (value !== null) values.set(field.key, value);
            else if (field.required) throw new Error('Заполните поле «' + field.label + '».');
        } catch (error) { throw Object.assign(error, { field: prefix + field.key }); }
    }
    return values;
}

function filters(fields, input) {
    const query = new URLSearchParams();
    const constraints = [];
    const allowed = new Set(fields.flatMap(field => field.type === 'number'
        ? [prefix + field.key + '_min', prefix + field.key + '_max'] : [prefix + field.key]));
    if (Object.keys(input).some(key => key.startsWith(prefix) && !allowed.has(key))) {
        throw new Error('Некоторые характеристики больше недоступны для этой категории. Проверьте фильтры.');
    }
    for (const field of fields) {
        const name = prefix + field.key;
        if (field.type === 'number') {
            const min = normalized(field, input[name + '_min'] ?? '');
            const max = normalized(field, input[name + '_max'] ?? '');
            if (min !== null && max !== null && min > max) throw new Error('Проверьте диапазон поля «' + field.label + '».');
            if (min !== null) query.set(name + '_min', min);
            if (max !== null) query.set(name + '_max', max);
            if (min !== null || max !== null) constraints.push({ key: field.key, min, max });
        } else {
            const raw = input[name] ?? '';
            const list = field.type === 'enum' ? [raw].flat() : [raw];
            if (list.length > (field.options?.length || 1)) throw new Error('Слишком много значений поля «' + field.label + '».');
            const values = [...new Set(list.map(value => normalized(field, value)).filter(Boolean))].sort();
            for (const value of values) query.append(name, value);
            if (values.length) {
                const matches = field.key === 'condition'
                    ? [...new Set(values.flatMap(code => [code, ...conditionOption(code, field).aliases]))] : values;
                constraints.push({ key: field.key, values: matches, labels: values });
            }
        }
    }
    return { query, constraints };
}

function display(key, value) {
    const field = fieldsByKey.get(key);
    const label = key === 'condition' ? conditionOption(value)?.label || String(value) : String(value);
    return field ? { key, label: field.label, value: field.unit ? value + ' ' + field.unit : label } : null;
}

function savedFilters(categoryId, categories, serialized) {
    const input = Object.create(null);
    for (const [key, value] of new URLSearchParams(serialized || '')) {
        if (!key.startsWith(prefix)) throw new Error('Некорректные сохранённые характеристики.');
        input[key] = Object.hasOwn(input, key) ? [input[key], value].flat() : value;
    }
    return filters(fieldsFor(categoryId, categories), input);
}

function labels(constraints) {
    return constraints.map(({ key, values, labels: codes, min, max }) => {
        const field = fieldsByKey.get(key);
        return field.label + ' · ' + (values ? (codes || values).map(code => display(key, code).value).join(' / ') :
            [min !== null && 'от ' + min, max !== null && 'до ' + max, field.unit].filter(Boolean).join(' '));
    });
}

module.exports = { fieldsFor, groups, listingValues, filters, display, savedFilters, labels, conditionOption };
