const multer = require('multer');
const { encode } = require('../services/listingImages');

const parser = multer({
    storage: multer.memoryStorage(),
    limits: { files: 5, fileSize: 2 * 1024 * 1024, fields: 3, parts: 9, fieldSize: 8192, headerPairs: 30 },
    fileFilter(_req, file, callback) {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
            return callback(Object.assign(new Error('Разрешены фотографии JPEG, PNG и WebP.'), { status: 400 }));
        }
        callback(null, true);
    }
}).array('photos', 5);

let active = 0;
module.exports = action => async (req, res) => {
    if (!req.is('multipart/form-data')) return action(req, res, []);
    if (active >= 2) return res.status(503).send('Загрузка занята. Повторите попытку позже.');
    active++;
    try {
        await new Promise((resolve, reject) => {
            const abort = () => reject(Object.assign(new Error('Загрузка прервана.'), { status: 400 }));
            req.once('aborted', abort);
            parser(req, res, error => {
                req.removeListener('aborted', abort);
                if (error) reject(error);
                else resolve();
            });
        });
        if (req.aborted) return;
        const images = [];
        for (const file of req.files) {
            const image = await encode(file.buffer);
            if (image.length > 3 * 1024 * 1024) {
                return res.status(413).send('Обработанная фотография слишком большая.');
            }
            images.push(image);
        }
        if (!req.aborted) await action(req, res, images);
    } catch (error) {
        if (req.aborted) return;
        if (error instanceof multer.MulterError) {
            return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
                .send('Можно приложить до пяти фотографий размером до 2 МБ каждая.');
        }
        throw error;
    } finally {
        active--;
    }
};
