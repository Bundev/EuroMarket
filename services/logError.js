const safeMessages = {
    ER_CANT_AGGREGATE_2COLLATIONS: 'Несовместимые правила сортировки MariaDB при сравнении строк.',
    ER_BAD_FIELD_ERROR: 'В схеме MariaDB отсутствует ожидаемый столбец.',
    ER_NO_SUCH_TABLE: 'В схеме MariaDB отсутствует ожидаемая таблица.',
    ER_LOCK_DEADLOCK: 'Конфликт блокировок MariaDB.',
    ER_LOCK_WAIT_TIMEOUT: 'Истекло время ожидания блокировки MariaDB.',
    ER_SIGNAL_EXCEPTION: 'Изменение отклонено правилом MariaDB.',
    ER_DATA_TOO_LONG: 'Значение превышает размер столбца MariaDB.'
};

module.exports = function logError(context, error, location) {
    const code = typeof error?.code === 'string' && /^(?:ER_[A-Z0-9_]{1,60}|E[A-Z0-9]{2,20}|ERR_[A-Z0-9_]{1,60})$/.test(error.code)
        ? error.code : 'ERROR';
    if (location) {
        const errno = Number.isSafeInteger(error?.errno) ? error.errno : null;
        const message = Object.hasOwn(safeMessages, code) ? safeMessages[code] : 'Сбой операции. Исходное сообщение скрыто.';
        console.error(context, { ...location, code, errno, message });
        return;
    }
    console.error(context, code);
};
