const logError = require('../services/logError');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const db = require('../config/db');
// libvips file caching otherwise keeps Windows upload files open after decoding.
sharp.cache({ files: 0, memory: 32, items: 20 });

const root = path.resolve(process.env.LISTING_IMAGE_STORAGE_ROOT || path.resolve(__dirname, '../.storage'));
const temporaryRoot = path.join(root, 'listing-uploads');
const imageRoot = path.join(root, 'listing-images');
const deletionRoot = path.join(root, 'listing-image-deletions');
const legacyRoot = path.resolve(__dirname, '../public/uploads/listings');
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PIXELS = 24_000_000;
const MAX_SIDE = 8192;
const safeName = /^[a-f0-9-]{36}\.webp$/;
let processing = 0;
const waiting = [];

async function acquireDecoder() {
    if (processing < 2) { processing++; return; }
    if (waiting.length >= 16) throw Object.assign(new Error('Обработка фотографий занята.'), { status: 503 });
    await new Promise((resolve, reject) => {
        const entry = { resolve };
        entry.timer = setTimeout(() => {
            waiting.splice(waiting.indexOf(entry), 1);
            reject(Object.assign(new Error('Обработка фотографий занята.'), { status: 503 }));
        }, 20000);
        waiting.push(entry);
    });
}

function releaseDecoder() {
    processing--;
    const entry = waiting.shift();
    if (entry) { clearTimeout(entry.timer); processing++; entry.resolve(); }
}

function invalid(message = 'Недопустимое или повреждённое изображение.') {
    return Object.assign(new Error(message), { status: 400 });
}

async function createJob() {
    await fs.mkdir(temporaryRoot, { recursive: true });
    await fs.mkdir(imageRoot, { recursive: true });
    return { directory: await fs.mkdtemp(path.join(temporaryRoot, 'upload-')), outputs: [], writes: [], abort: new AbortController() };
}

async function encode(input) {
    await acquireDecoder();
    try {
        const { fileTypeFromFile, fileTypeFromBuffer } = await import('file-type');
        const type = await (Buffer.isBuffer(input) ? fileTypeFromBuffer(input) : fileTypeFromFile(input));
        if (!type || !['image/jpeg', 'image/png', 'image/webp'].includes(type.mime)) throw invalid();
        const decoder = sharp(input, { failOn: 'warning', limitInputPixels: MAX_PIXELS, sequentialRead: true });
        const metadata = await decoder.metadata();
        if (!['jpeg', 'png', 'webp'].includes(metadata.format) ||
            !metadata.width || !metadata.height || metadata.width > MAX_SIDE || metadata.height > MAX_SIDE ||
            metadata.width * metadata.height > MAX_PIXELS || (metadata.pages || 1) !== 1) throw invalid('Слишком большое или анимированное изображение.');
        // Full decoding, re-encoding and metadata removal. Original bytes are never published.
        return await decoder.rotate().resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 85, effort: 4 }).timeout({ seconds: 10 }).toBuffer();
    } catch (error) {
        if (error.status) throw error;
        throw invalid();
    } finally { releaseDecoder(); }
}

async function prepare(req) {
    const job = req.imageUpload;
    for (const file of req.files || []) {
        const buffer = await encode(file.path);
        const name = crypto.randomUUID() + '.webp';
        await fs.writeFile(path.join(job.directory, name), buffer, { flag: 'wx', mode: 0o600 });
        job.outputs.push(name);
    }
    // Durable compensation record, written BEFORE files can become permanent.
    await fs.writeFile(path.join(job.directory, 'manifest.json'), JSON.stringify(job.outputs), { flag: 'wx', mode: 0o600 });
    return job.outputs.map(name => '/uploads/listings/' + name);
}

async function publish(req) {
    for (const name of req.imageUpload.outputs) await fs.rename(path.join(req.imageUpload.directory, name), path.join(imageRoot, name));
}

async function removeUnreferenced(names) {
    if (!Array.isArray(names) || !names.every(name => safeName.test(name))) throw new Error('INVALID_IMAGE_MANIFEST');
    if (!names.length) return;
    const paths = names.map(name => '/uploads/listings/' + name);
    // Resolves an ambiguous COMMIT failure too: never remove a committed image.
    const [rows] = await db.execute(`SELECT image_path FROM listing_images WHERE image_path IN (${paths.map(() => '?').join(',')})`, paths);
    const referenced = new Set(rows.map(row => row.image_path));
    for (const name of names) if (!referenced.has('/uploads/listings/' + name)) {
        await fs.unlink(path.join(imageRoot, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
}

async function dispose(req, committed) {
    const job = req.imageUpload;
    if (!job) return;
    // Parser error and request abort can arrive together. Clean a job only once.
    if (job.disposal) return job.disposal;
    job.disposal = disposeJob(job, committed);
    return job.disposal;
}

async function disposeJob(job, committed) {
    await Promise.allSettled(job.writes);
    try {
        if (!committed) await removeUnreferenced(job.outputs);
        await removeJob(job.directory);
    } catch (error) {
        // Preserve manifest if DB/disk is unavailable. Reconciliation can retry safely.
        logError('IMAGE_CLEANUP_DEFERRED', error);
        job.disposal = null;
    } finally { job.release?.(); }
}

async function removeJob(directory) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== temporaryRoot || !path.basename(target).startsWith('upload-')) throw new Error('INVALID_UPLOAD_DIRECTORY');
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

async function removeStored(imagePath) {
    const name = path.basename(imagePath);
    if (imagePath !== '/uploads/listings/' + name || !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(name)) throw new Error('INVALID_IMAGE_PATH');
    for (const directory of [imageRoot, legacyRoot]) {
        await fs.unlink(path.join(directory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
}

async function queueDeletion(imagePath) {
    await fs.mkdir(deletionRoot, { recursive: true });
    const name = crypto.randomUUID() + '.json';
    await fs.writeFile(path.join(deletionRoot, name), JSON.stringify({ imagePath }), { flag: 'wx', mode: 0o600 });
    return name;
}

async function finishDeletion(name) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw new Error('INVALID_DELETION_MANIFEST');
    const target = path.join(deletionRoot, name);
    const { imagePath } = JSON.parse(await fs.readFile(target, 'utf8'));
    const [rows] = await db.execute('SELECT id FROM listing_images WHERE image_path=? LIMIT 1', [imagePath]);
    if (!rows.length) await removeStored(imagePath);
    await fs.unlink(target);
}

const imageNamePattern = /^[a-zA-Z0-9_-]+\.(?:jpe?g|png|webp)$/i;

async function validateForReview(imagePath) {
    const name = imagePath.split('/').pop();
    if (!imageNamePattern.test(name) || imagePath !== '/uploads/listings/' + name) throw invalid('Недопустимый путь фотографии.');
    const candidates = safeName.test(name) ? [path.join(imageRoot, name), path.join(legacyRoot, name)] : [path.join(legacyRoot, name)];
    for (const candidate of candidates) {
        try {
            const stat = await fs.stat(candidate);
            if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw invalid('Недопустимая фотография.');
            await encode(candidate);
            return;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
    throw invalid('Фотография отсутствует. Попросите продавца загрузить её повторно.');
}

// The same path works after approval and is protected immediately after unpublishing.
async function serve(req, res) {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    if (!['GET', 'HEAD'].includes(req.method)) return res.sendStatus(405);
    const name = req.path.slice(1);
    if (!imageNamePattern.test(name)) return res.sendStatus(404);
    try {
        const viewer = req.session?.user?.id ?? null;
        const [[allowed]] = await db.execute(
            `SELECT (l.status='active' AND l.moderation_locked=0 AND owner.status='active') AS is_public
             FROM listing_images i JOIN listings l ON l.id=i.listing_id
             JOIN users owner ON owner.id=l.user_id
             LEFT JOIN users viewer ON viewer.id=? AND viewer.status='active'
             WHERE i.image_path=? AND (
                 (l.status='active' AND l.moderation_locked=0 AND owner.status='active')
                 OR viewer.id=l.user_id OR viewer.role='admin'
                 OR (viewer.id IS NOT NULL AND l.status='sold' AND l.moderation_locked=0 AND owner.status='active'
                     AND EXISTS (SELECT 1 FROM deals d WHERE d.reserved_listing_id=l.id AND d.buyer_id=viewer.id AND d.status='completed'))
             ) LIMIT 1`, [viewer, '/uploads/listings/' + name]
        );
        if (!allowed) return res.sendStatus(404);
        if (allowed.is_public) res.removeHeader('X-Robots-Tag');
        if (safeName.test(name)) {
            try {
                await fs.access(path.join(imageRoot, name));
                res.type('image/webp');
                return res.sendFile(name, { root: imageRoot, dotfiles: 'deny', cacheControl: false }, error => { if (error && !res.headersSent) res.sendStatus(404); });
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const original = path.join(legacyRoot, name);
        const stat = await fs.stat(original);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return res.sendStatus(404);
        res.type('image/webp').send(await encode(original));
    } catch (error) { res.sendStatus(error.status === 503 ? 503 : 404); }
}

async function reconcile() {
    await fs.mkdir(temporaryRoot, { recursive: true });
    for (const entry of await fs.readdir(temporaryRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('upload-')) continue;
        const directory = path.join(temporaryRoot, entry.name);
        if (Date.now() - (await fs.stat(directory)).mtimeMs < 24 * 60 * 60 * 1000) continue;
        let names;
        try { names = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
        await removeUnreferenced(names);
        await removeJob(directory);
    }
    await fs.mkdir(deletionRoot, { recursive: true });
    for (const name of await fs.readdir(deletionRoot)) {
        if (Date.now() - (await fs.stat(path.join(deletionRoot, name))).mtimeMs >= 24 * 60 * 60 * 1000) await finishDeletion(name);
    }
}

module.exports = { MAX_FILE_BYTES, invalid, encode, createJob, prepare, publish, dispose, queueDeletion, finishDeletion, serve, reconcile, validateForReview };
