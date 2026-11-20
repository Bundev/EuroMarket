
const db = require('../config/db');

// Сохранение фотографий объявления
async function addImages(listingId, imagePaths, startOrder = 0, connection = db) {
    if (!imagePaths.length) {
        return;
    }

    const values = imagePaths.map((imagePath, index) => [
        listingId,
        imagePath,
        startOrder + index
    ]);

    const placeholders = values
        .map(() => '(?, ?, ?)')
        .join(', ');

    const params = values.flat();

    await connection.query(
        `INSERT INTO listing_images
            (listing_id, image_path, sort_order)
         VALUES ${placeholders}`,
        params
    );
}

// Получение фотографий объявления
async function getImagesByListingId(listingId, connection = db) {
    const [rows] = await connection.execute(
        `SELECT id, image_path, sort_order
         FROM listing_images
         WHERE listing_id = ?
         ORDER BY sort_order ASC, id ASC`,
        [listingId]
    );

    return rows;
}

async function reorder(listingId, ids, connection) {
    const cases = ids.map(() => 'WHEN ? THEN ?').join(' ');
    await connection.execute(`UPDATE listing_images SET sort_order=CASE id ${cases} ELSE sort_order END WHERE listing_id=?`,
        [...ids.flatMap((id, index) => [id, index]), listingId]);
}

// Удаление записи фотографии
async function deleteImage(imageId, listingId, connection = db) {
    const [result] = await connection.execute(
        `DELETE FROM listing_images
         WHERE id = ? AND listing_id = ?`,
        [imageId, listingId]
    );

    return result.affectedRows > 0;
}


module.exports = {
    addImages,
    getImagesByListingId,
    reorder,
    deleteImage

};
