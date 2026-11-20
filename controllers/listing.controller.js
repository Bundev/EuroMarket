const logError = require('../services/logError');

const listingModel = require('../models/listing.model');
const db = require('../config/db');
const listingImageModel = require('../models/listingImage.model');
const images = require('../services/listingImages');
const transaction = require('../config/transaction');
const { lockEditable, contentChanged, editableStatuses } = require('../models/listingModeration.model');
const { flash } = require('../middleware/toasts');
const { hasCompletedPurchase } = require('../models/deal.model');
const { ratingFor } = require('../models/review.model');
const { isFollowing } = require('../models/follow.model');
const recentlyViewed = require('../models/recentlyViewed.model');
const recommendations = require('../models/recommendation.model');
const marketplaceTools = require('../models/marketplaceTools.model');
const attributeDefinitions = require('../services/listingAttributes');
const attributes = require('../models/listingAttributes.model');

async function parseAttributes(categoryId, input) {
    const fields = attributeDefinitions.fieldsFor(categoryId, await getAllCategories());
    try { return attributeDefinitions.listingValues(fields, input); }
    catch (error) { throw Object.assign(error, { status: 400 }); }
}

const seo = require('../services/seo');
const { getAllCategories, getCategoryAncestors, isServiceCategory } = require('../models/category.model');
const breadcrumbs = require('../services/breadcrumbs');

function uploadResult(req, res, redirect) {
    return req.get('Accept') === 'application/json' ? res.json({ redirect }) : res.redirect(redirect);
}

function editorError(req, res, status, message, field) {
    return req.get('Accept') === 'application/json'
        ? res.status(status).json({ error: message, field })
        : res.status(status).send(message);
}

// Страница создания объявления
async function createPage(req, res) {
    res.set('Cache-Control', 'private, no-store');
    try {
        const categories = (await getAllCategories()).sort((a, b) => a.name.localeCompare(b.name));

        const [countries] = await db.execute(
            `SELECT id, code, name, currency
             FROM countries
             WHERE is_active = 1
             ORDER BY name`
        );

        res.render('pages/listing-create', {
            categories,
            attributeGroups: attributeDefinitions.groups(categories),
            countries,
            error: null
        });

    } catch (error) {
        logError('Ошибка загрузки формы:', error);
        res.status(500).send('Ошибка сервера');
    }
}

// Сохранение объявления
async function store(req, res) {
    let committed = false;
    try {
        const {
            title,
            description,
            category_id,
            country_id,
            price
        } = req.body;

        const categoryId = Number(category_id);
        const countryId = Number(country_id);
        const cityId = req.body.city_id ? Number(req.body.city_id) : null;
        const priceNumber = Number(price);

        if (
            typeof title !== 'string' ||
            typeof description !== 'string' ||
            !title.trim() ||
            title.trim().length > 200 ||
            !description.trim() ||
            !Number.isSafeInteger(categoryId) ||
            categoryId <= 0 ||
            !Number.isSafeInteger(countryId) ||
            countryId <= 0 ||
            !Number.isFinite(priceNumber) ||
            priceNumber < 0 ||
            priceNumber > 9999999999.99
        ) {
            return res.status(400).send(
                'Проверьте данные объявления'
            );
        }

        // Проверяем категорию и страну
        const [rows] = await db.execute(
            `SELECT
                (SELECT COUNT(*) FROM categories
                 WHERE id = ? AND is_active = 1) AS category_exists,
                (SELECT currency FROM countries
                 WHERE id = ? AND is_active = 1) AS currency`,
            [categoryId, countryId]
        );

        if (!rows[0].category_exists || !rows[0].currency) {
            return res.status(400).send(
                'Выбрана неверная категория или страна'
            );
        }

        if (cityId !== null) {
            if (!Number.isSafeInteger(cityId) || cityId <= 0) {
                return editorError(req, res, 400, 'Некорректный город', 'city_id');
            }

            const [cities] = await db.execute(
                `SELECT id
                 FROM cities
                 WHERE id = ?
                   AND country_id = ?
                   AND is_active = 1
                 LIMIT 1`,
                [cityId, countryId]
            );

            if (!cities.length) {
                return editorError(req, res, 400, 'Город не принадлежит выбранной стране', 'city_id');
            }
        }

        const attributeValues = await parseAttributes(categoryId, req.body);
        const imagePaths = req.imageUpload ? await images.prepare(req) : [];
        const listingId = await transaction(async connection => {
            const [users] = await connection.execute("SELECT id FROM users WHERE id=? AND status='active' FOR UPDATE", [req.session.user.id]);
            if (!users.length) throw Object.assign(new Error('Аккаунт недоступен.'), { status: 403 });
            const id = await listingModel.createListing({
                userId: req.session.user.id, categoryId, countryId, cityId,
                title: title.trim(), description: description.trim(), price: priceNumber,
                bargainingEnabled: req.body.bargaining_enabled === '1',
                currency: rows[0].currency,
                attributes: attributeValues
            }, connection);
            await listingImageModel.addImages(id, imagePaths, 0, connection);
            if (req.imageUpload) await images.publish(req);
            return id;
        });
        committed = true;

        flash(req, 'success', 'Объявление создано.');

        return uploadResult(req, res, `/my-listings?created=${listingId}`);

    } catch (error) {
        logError('Ошибка создания объявления:', error);
        if ([400, 403, 404].includes(error.status)) return editorError(req, res, error.status, error.message, error.field);
        res.status(error.status === 503 ? 503 : 500).send('Не удалось сохранить объявление.');
    } finally {
        await images.dispose(req, committed);
    }
}


async function show(req, res) {
    try {
        const id = Number(req.params.id);

        if (!Number.isSafeInteger(id) || id <= 0 || id > 4294967295 || !/^\d+$/.test(req.params.id)) {
            return res.status(404).send('Объявление не найдено');
        }

        const listing = await listingModel.getListingById(id);

        if (!listing) {
            return res.status(404).send('Объявление не найдено');
        }

        const currentUserId = req.session.user?.id;
        if (listing.seller_status !== 'active' && Number(currentUserId) !== Number(listing.user_id) && req.session.user?.role !== 'admin') {
            return res.status(404).send('Объявление не найдено');
        }

        const isPublic = listing.status === 'active' && !listing.is_expired && !listing.moderation_locked && listing.seller_status === 'active';
        if (
            !isPublic &&
            Number(currentUserId) !== Number(listing.user_id) &&
            req.session.user?.role !== 'admin' &&
            !(currentUserId && listing.status === 'sold' && !listing.moderation_locked &&
                await hasCompletedPurchase(listing.id, currentUserId))
        ) {
            return res.status(404).send('Объявление не найдено');
        }
        const path = seo.listingPath(listing);
        if (isPublic && req.path !== path) {
            // Access is checked before returning a redirect or disclosing a slug.
            return res.redirect(301, path);
        }
        if (!isPublic) res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'private, no-store' });

        const images = await listingImageModel.getImagesByListingId(
            listing.id
        );
        const categories = await getAllCategories({ includeInactive: true });
        const category = categories.find(item => Number(item.id) === Number(listing.category_id));
        const ancestors = category ? getCategoryAncestors(category, categories) : [];
        const isService = isServiceCategory(ancestors);
        res.locals.pageBreadcrumbs = breadcrumbs.trail(
            ...ancestors.filter(item => item.is_active).map(item => ({ name: item.name, path: seo.categoryPath(item.slug) })),
            { name: listing.title, path });
        if (isPublic) {
            const name = seo.plain(listing.title, 100) || 'Объявление №' + listing.id;
            const place = seo.plain(listing.country_name, 35);
            const categoryName = seo.plain(listing.category_name, 45);
            const description = `Объявление №${listing.id} на EuroMarket. Категория: ${categoryName}. Страна: ${place}. Цена: ${listing.price} ${listing.currency}.`;
            const allowedImages = images.map(image => seo.localImage(image.image_path)).filter(Boolean);
            const url = seo.absolute(res, path);
            const product = { '@type': 'Product', name, description, url };
            if (categoryName) product.category = categoryName;
            if (allowedImages.length) product.image = allowedImages.map(image => seo.absolute(res, image));
            if (/^\d+(?:\.\d{1,2})?$/.test(String(listing.price)) && /^[A-Z]{3}$/.test(listing.currency)) {
                product.offers = {
                    '@type': 'Offer', url, price: String(listing.price), priceCurrency: listing.currency,
                    availability: listing.reserved ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock'
                };
            }
            seo.apply(res, {
                path, title: `${name} · ${place} · №${listing.id} — EuroMarket`, description, image: allowedImages[0],
                structured: { '@context': 'https://schema.org', '@graph': [product] }
            });
        }

        const canFollowSeller = isPublic && Number(currentUserId) !== Number(listing.user_id);
        const canOfferPrice = Boolean(!isService && currentUserId && isPublic &&
            Number(currentUserId) !== Number(listing.user_id) && listing.bargaining_enabled && !listing.reserved);
        const sellerFollow = canFollowSeller ? {
            following: currentUserId ? await isFollowing(listing.user_id, currentUserId) : false
        } : null;
        const recentListings = res.locals.viewingHistoryEnabled ? await recentlyViewed.preview(currentUserId, listing.id) : [];
        const related = isPublic ? await recommendations({ userId: currentUserId,
            countryId: res.locals.selectedCountryInfo?.id, similar: listing, previewSize: 4 }) : null;
        res.set('Cache-Control', 'private, no-store');

        res.render('pages/listing-show', {
            listing,
            characteristics: attributes.formatted((await attributes.load([listing.id], db, isPublic)).get(listing.id), listing.item_condition),
            images,
            isService,
            purchaseRequestKey: !isService && currentUserId && isPublic &&
                Number(currentUserId) !== Number(listing.user_id) ? require('node:crypto').randomUUID() : null,
            reviewKey: req.session.user?.role === 'admin' && listing.status === 'pending_review'
                ? require('node:crypto').randomUUID() : null,
            sellerRating: await ratingFor(listing.user_id),
            sellerFollow,
            recentListings,
            isPublic,
            offerRequestKey: canOfferPrice ? require('node:crypto').randomUUID() : null,
            priceAlert: isPublic && res.locals.favoriteIds?.has(Number(listing.id))
                ? await marketplaceTools.priceAlert(listing.id, currentUserId) : null,
            priceHistory: isPublic || Number(currentUserId) === Number(listing.user_id)
                ? await marketplaceTools.prices(listing.id, currentUserId) : [],
            related: related?.listings,
            listingPath: seo.listingPath,
            recordView: Boolean(canFollowSeller && currentUserId && res.locals.viewingHistoryEnabled),
            reportReasons: require('../config/reportReasons'),
        });

    } catch (error) {
        logError('Ошибка загрузки объявления:', error);
        res.status(500).send('Ошибка сервера');
    }
}


// Страница редактирования объявления
async function editPage(req, res) {
    res.set('Cache-Control', 'private, no-store');
    try {
        const listingId = Number(req.params.id);

        if (!Number.isSafeInteger(listingId) || listingId <= 0) {
            return res.status(404).send('Объявление не найдено');
        }

        const listing = await listingModel.getListingById(listingId);

        if (
            !listing ||
            Number(listing.user_id) !== Number(req.session.user.id) ||
            !editableStatuses.includes(listing.status)
        ) {
            return res.status(404).send('Объявление не найдено');
        }

        const categories = (await getAllCategories()).sort((a, b) => a.name.localeCompare(b.name));
        const images = await listingImageModel.getImagesByListingId(
            listingId
        );
        const [countries] = await db.execute(
            `SELECT id, code, name, currency
            FROM countries
            WHERE is_active = 1
            ORDER BY name`
        );
        res.render('pages/listing-edit', {
            listing,
            categories,
            attributeGroups: attributeDefinitions.groups(categories),
            attributeValues: (await attributes.load([listingId])).get(listingId) || new Map(),
            images,
            countries,
            error: null
        });

    } catch (error) {
        logError('Ошибка открытия редактора:', error);
        res.status(500).send('Ошибка сервера');
    }
}

// Сохранение изменений
async function update(req, res) {
    let stage = 'validation';
    let committed = false;
    const deletions = [];
    try {
        const listingId = Number(req.params.id);
        const userId = req.session.user.id;

        const {
            title,
            description,
            category_id,
            price,
            bargaining_enabled: bargainingEnabled,
            editor_version: editorVersion,
            photo_order: photoOrder
        } = req.body ?? {};

        const categoryId = Number(category_id);
        const priceNumber = Number(price);

        if (
            !Number.isSafeInteger(listingId) ||
            listingId <= 0 ||
            typeof title !== 'string' ||
            !title.trim() ||
            title.trim().length > 200 ||
            typeof description !== 'string' ||
            !description.trim() ||
            !Number.isSafeInteger(categoryId) ||
            categoryId <= 0 ||
            !Number.isFinite(priceNumber) ||
            priceNumber < 0 ||
            priceNumber > 9999999999.99 ||
            (bargainingEnabled !== undefined && !['0', '1'].includes(bargainingEnabled)) ||
            (editorVersion !== undefined && (typeof editorVersion !== 'string' || !/^\d{1,10}$/.test(editorVersion))) ||
            (photoOrder !== undefined && (typeof photoOrder !== 'string' || photoOrder.length > 280 ||
                (photoOrder !== '' && !/^(?:(?:id|remove):\d{1,10}|new:\d)(?:,(?:(?:id|remove):\d{1,10}|new:\d))*$/.test(photoOrder))))
        ) {
            return res.status(400).send(
                'Проверьте введённые данные'
            );
        }

        stage = 'category';
        const [categories] = await db.execute(
            `SELECT id FROM categories
             WHERE id = ? AND is_active = 1`,
            [categoryId]
        );

        if (categories.length === 0) {
            return res.status(400).send(
                'Выбрана неверная категория'
            );
        }


        const countryId = Number(req.body.country_id);

        const cityId = req.body.city_id
            ? Number(req.body.city_id)
            : null;

        if (!Number.isSafeInteger(countryId) || countryId <= 0) {
            return editorError(req, res, 400, 'Некорректная страна', 'country_id');
        }

        stage = 'country-currency';
        const [validCountries] = await db.execute(
            `SELECT id, currency
            FROM countries
            WHERE id = ? AND is_active = 1
            LIMIT 1`,
            [countryId]
        );

        if (!validCountries.length) {
            return editorError(req, res, 400, 'Страна не найдена', 'country_id');
        }

        if (cityId !== null) {
            if (!Number.isSafeInteger(cityId) || cityId <= 0) {
                return editorError(req, res, 400, 'Некорректный город', 'city_id');
            }

            stage = 'city';
            const [validCities] = await db.execute(
                `SELECT id
                FROM cities
                WHERE id = ?
                AND country_id = ?
                AND is_active = 1
                LIMIT 1`,
                [cityId, countryId]
            );

            if (!validCities.length) {
                return res.status(400).send(
                    'Город не принадлежит выбранной стране'
                );
            }
        }


        stage = 'attributes';
        const attributeValues = await parseAttributes(categoryId, req.body);
        stage = 'photos';
        const photoPaths = req.files?.length ? await images.prepare(req) : [];
        stage = 'listing-transaction';
        const { pending } = await listingModel.updateListing(
            listingId,
            userId,
            {
                title: title.trim(),
                description: description.trim(),
                bargainingEnabled: bargainingEnabled === undefined ? undefined : bargainingEnabled === '1',
                categoryId,
                countryId,
                cityId,
                price: priceNumber,
                currency: validCountries[0].currency,
                attributes: attributeValues,
                editorVersion: editorVersion === undefined ? undefined : Number(editorVersion),
                photoPaths,
                photoOrder: photoOrder === undefined ? undefined : photoOrder ? photoOrder.split(',') : [],
                publishPhotos: () => images.publish(req),
                stagePhotoDeletion: async path => { deletions.push(await images.queueDeletion(path)); }
            }
        );

        stage = 'response';
        committed = true;
        flash(req, 'success', pending ? 'Объявление отправлено на проверку.' : 'Изменения объявления сохранены.');

        return uploadResult(req, res, req.get('Accept') === 'application/json' ? `/listings/${listingId}/edit` : `/listings/${listingId}`);

    } catch (error) {
        if ([400, 403, 404, 409, 503].includes(error.status)) return editorError(req, res, error.status, error.message, error.field);
        logError('Ошибка обновления объявления:', error, { file: 'controllers/listing.controller.js', stage });
        res.status(500).send('Ошибка сервера');
    } finally {
        if (req.imageUpload) await images.dispose(req, committed);
        for (const name of deletions) await images.finishDeletion(name).catch(error => logError('IMAGE_DELETE_DEFERRED', error));
    }
}


async function removeImage(req, res) {
    let deletion;
    try {
        const listingId = Number(req.params.id);
        const imageId = Number(req.params.imageId);
        const userId = req.session.user.id;

        if (
            !Number.isSafeInteger(listingId) ||
            listingId <= 0 ||
            !Number.isSafeInteger(imageId) ||
            imageId <= 0
        ) {
            return res.status(404).send('Фотография не найдена');
        }

        const pending = await transaction(async connection => {
            const listing = await lockEditable(connection, listingId, userId);
            const [[image]] = await connection.execute(
                'SELECT image_path FROM listing_images WHERE id=? AND listing_id=? FOR UPDATE', [imageId, listingId]
            );
            if (!image) throw Object.assign(new Error('Фотография не найдена.'), { status: 404 });
            deletion = await images.queueDeletion(image.image_path);
            await listingImageModel.deleteImage(imageId, listingId, connection);
            return contentChanged(connection, listing);
        });

        await images.finishDeletion(deletion);
        deletion = null;

        flash(req, 'success', pending ? 'Объявление отправлено на проверку.' : 'Фотография удалена.');

        res.redirect(`/listings/${listingId}/edit`);

    } catch (error) {
        if ([403, 404, 409].includes(error.status)) return res.status(error.status).send(error.message);
        logError('Ошибка удаления фотографии:', error);
        res.status(500).send('Ошибка сервера');
    } finally {
        if (deletion) await images.finishDeletion(deletion).catch(error => logError('IMAGE_DELETE_DEFERRED', error));
    }
}



async function addListingImages(req, res) {
    let committed = false;
    try {
        const listingId = Number(req.params.id);
        if (!Number.isSafeInteger(listingId) || listingId <= 0) return res.status(404).send('Объявление не найдено');
        const listing = await listingModel.getListingById(listingId);
        if (!listing || Number(listing.user_id) !== Number(req.session.user.id) || !editableStatuses.includes(listing.status)) return res.status(404).send('Объявление не найдено');
        if (!req.files?.length) return res.status(400).send('Выберите фотографии');
        const imagePaths = await images.prepare(req);
        const pending = await transaction(async connection => {
            const current = await lockEditable(connection, listingId, req.session.user.id);
            const [[count]] = await connection.execute('SELECT COUNT(*) AS total, COALESCE(MAX(sort_order), -1) AS last_order FROM listing_images WHERE listing_id=?', [listingId]);
            if (Number(count.total) + imagePaths.length > 10) throw Object.assign(new Error('Можно хранить до 10 фотографий.'), { status: 400 });
            await listingImageModel.addImages(listingId, imagePaths, Number(count.last_order) + 1, connection);
            await images.publish(req);
            return contentChanged(connection, current);
        });
        committed = true;
        flash(req, 'success', pending ? 'Объявление отправлено на проверку.' : 'Фотографии добавлены.');
        return uploadResult(req, res, '/listings/' + listingId + '/edit');
    } catch (error) {
        logError('Ошибка загрузки фотографий:', error);
        if ([400, 403, 404, 409].includes(error.status)) return res.status(error.status).send(error.message);
        res.status(error.status === 503 ? 503 : 500).send('Не удалось сохранить фотографии.');
    } finally {
        await images.dispose(req, committed);
    }
}


async function publish(req, res) {
    try {
        const listingId = Number(req.params.id);
        const userId = req.session.user.id;

        if (
            !Number.isSafeInteger(listingId) ||
            listingId <= 0
        ) {
            return res.status(404).send(
                'Объявление не найдено'
            );
        }

        const published = await listingModel.publishListing(
            listingId,
            userId
        );

        if (!published) {
            return res.status(404).send(
                'Объявление не найдено или уже опубликовано'
            );
        }

        flash(req, 'success', 'Объявление отправлено на проверку.');

        return res.redirect('/my-listings');

    } catch (error) {
        if ([403, 404, 409].includes(error.status)) return res.status(error.status).send(error.message);
        if (error.code === 'ER_SIGNAL_EXCEPTION') {
            return res.status(409).send('Публикация ограничена. Обновите страницу и проверьте статус объявления.');
        }
        logError('Ошибка публикации:', error);

        return res.status(500).send(
            'Ошибка публикации объявления'
        );
    }
}



async function unpublish(req, res) {
    try {
        const listingId = Number(req.params.id);
        const userId = req.session.user.id;

        if (!Number.isSafeInteger(listingId) || listingId <= 0) {
            return res.status(404).send('Объявление не найдено');
        }

        const updated = await listingModel.unpublishListing(
            listingId,
            userId
        );

        if (!updated) {
            return res.status(404).send(
                'Объявление не найдено или уже снято с публикации'
            );
        }

        flash(req, 'success', 'Объявление снято с публикации.');

        return res.redirect('/my-listings');

    } catch (error) {
        logError('Ошибка снятия с публикации:', error);
        return res.status(500).send('Ошибка сервера');
    }
}


async function markSold(req, res) {
    try {
        const listingId = Number(req.params.id);
        const userId = req.session.user.id;

        if (!Number.isSafeInteger(listingId) || listingId <= 0) {
            return res.status(404).send('Объявление не найдено');
        }

        const updated = await listingModel.markListingSold(
            listingId,
            userId
        );

        if (!updated) {
            return res.status(404).send(
                'Объявление не найдено или недоступно для продажи'
            );
        }

        flash(req, 'success', 'Объявление отмечено как проданное.');

        return res.redirect('/my-listings');

    } catch (error) {
        if (error.status === 409) return res.status(409).send(error.message);
        logError('Ошибка изменения статуса:', error);
        return res.status(500).send('Ошибка сервера');
    }
}


module.exports = {
    createPage,
    store,
    show,
    editPage,
    update,
    removeImage,
    addListingImages,
    publish,
    unpublish,
    markSold
};
