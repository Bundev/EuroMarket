function configuration(env = process.env) {
    if (!env.SMS_WEBHOOK_URL || !env.SMS_WEBHOOK_TOKEN || !/^[a-f0-9]{64}$/i.test(env.SMS_VERIFICATION_KEY || '')) return null;
    try {
        const url = new URL(env.SMS_WEBHOOK_URL);
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
        return { url, token: env.SMS_WEBHOOK_TOKEN, key: Buffer.from(env.SMS_VERIFICATION_KEY, 'hex') };
    } catch { return null; }
}

async function send({ url, token }, phone, code) {
    const response = await fetch(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ to: phone, text: 'EuroMarket: код подтверждения ' + code + '. Действует 10 минут.' })
    });
    if (response.body) await response.body.cancel();
    if (!response.ok) throw new Error('SMS provider rejected delivery');
}

module.exports = { configuration, send };
