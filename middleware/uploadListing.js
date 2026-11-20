const multer = require('multer');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const images = require('../services/listingImages');

const storage = {
    _handleFile(req, file, callback) {
        const target = path.join(req.imageUpload.directory, crypto.randomUUID() + '.upload');
        const output = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
        const task = pipeline(file.stream, output, { signal: req.imageUpload.abort.signal });
        req.imageUpload.writes.push(task);
        task.then(() => callback(null, { path: target, size: output.bytesWritten }), callback);
    },
    _removeFile(req, file, callback) {
        fs.unlink(file.path, error => callback(error?.code === 'ENOENT' ? null : error));
    }
};

function parser(fields) { return multer({
    storage,
    limits: { fileSize: images.MAX_FILE_BYTES, files: 10, fields, parts: fields + 11, fieldSize: 64 * 1024, fieldNameSize: 100, headerPairs: 100 },
    fileFilter(req, file, callback) {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype) || !/\.(?:jpe?g|png|webp)$/i.test(file.originalname)) {
            return callback(images.invalid('Разрешены только JPEG, PNG и WebP.'));
        }
        callback(null, true);
    }
}); }

let active = 0;
module.exports.array = (field, count, fields = 16) => {
    const parse = parser(fields).array(field, count);
    return async (req, res, next) => {
    if (!req.is('multipart/form-data')) return next();
    if (active >= 4) return res.status(503).send('Загрузка занята. Повторите попытку позже.');
    active++;
    let released = false;
    const release = () => { if (!released) { active--; released = true; } };
    try {
        req.imageUpload = await images.createJob();
        const abort = () => {
            req.imageUpload.abort.abort();
            void images.dispose(req, false).finally(release);
        };
        req.once('aborted', abort);
        parse(req, res, async error => {
            req.removeListener('aborted', abort);
            if (error || req.aborted) {
                await images.dispose(req, false);
                release();
                if (!req.aborted) res.status(error?.code === 'LIMIT_FILE_SIZE' ? 413 : 400).send('Не удалось загрузить фотографии. Проверьте формат и ограничения загрузки.');
                return;
            }
            req.imageUpload.release = release;
            next();
        });
    } catch (error) {
        if (req.imageUpload) await images.dispose(req, false);
        release();
        res.status(503).send('Не удалось начать загрузку фотографий.');
    }
    };
};
