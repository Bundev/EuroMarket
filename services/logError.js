module.exports = function logError(context, error) {
    const code = typeof error?.code === 'string' && /^(?:ER_[A-Z_]{1,60}|E[A-Z]{2,20}|ERR_[A-Z_]{1,60})$/.test(error.code)
        ? error.code : 'ERROR';
    console.error(context, code);
};
