// Optional server-side translation for final chatbot responses.
// English bypasses this module; failures intentionally fall back to the
// response already produced by the existing chatbot.

const LANGUAGE_CODES = Object.freeze({
    EN: 'eng_Latn',
    HI: 'hin_Deva',
    HN: 'hin_Deva',
    KN: 'kan_Knda'
});

function protectContent(text) {
    const protectedValues = [];
    const pattern = /```[\s\S]*?```|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:GS|APP)-[A-Z0-9-]+\b|₹\s?[\d,]+(?:\.\d+)?|\b\d{6,}\b|\b\d+(?:\.\d+)?%\b/g;
    const protectedText = String(text || '').replace(pattern, value => {
        const marker = `GIGSYNCTOKEN${protectedValues.length}END`;
        protectedValues.push(value);
        return marker;
    });
    return { protectedText, protectedValues };
}

function restoreContent(text, protectedValues) {
    return String(text || '').replace(/GIGSYNCTOKEN(\d+)END/g, (match, index) => protectedValues[Number(index)] || match);
}

async function translateResponseIfRequired(message, language) {
    const normalizedLanguage = String(language || 'EN').toUpperCase();
    const targetLanguage = LANGUAGE_CODES[normalizedLanguage] || LANGUAGE_CODES.EN;
    const serviceUrl = String(process.env.TRANSLATION_SERVICE_URL || '').trim().replace(/\/$/, '');
    if (!message || targetLanguage === LANGUAGE_CODES.EN || !serviceUrl) return message;

    // Existing direct/local responses may already be in the requested script.
    if ((normalizedLanguage === 'HI' || normalizedLanguage === 'HN') && /[\u0900-\u097F]/u.test(message)) return message;
    if (normalizedLanguage === 'KN' && /[\u0C80-\u0CFF]/u.test(message)) return message;

    const { protectedText, protectedValues } = protectContent(message);
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.TRANSLATION_SERVICE_TOKEN) headers.Authorization = `Bearer ${process.env.TRANSLATION_SERVICE_TOKEN}`;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const response = await fetch(`${serviceUrl}/translate`, {
            method: 'POST',
            headers,
            signal: controller.signal,
            body: JSON.stringify({ text: protectedText, source_language: LANGUAGE_CODES.EN, target_language: targetLanguage })
        });
        clearTimeout(timeout);
        if (!response.ok) throw new Error(`translation service returned ${response.status}`);
        const body = await response.json();
        if (!body.translation) throw new Error('translation service returned no translation');
        return restoreContent(body.translation, protectedValues);
    } catch (error) {
        console.warn('[Translation] Falling back to existing response:', error.message);
        return message;
    }
}

module.exports = { LANGUAGE_CODES, translateResponseIfRequired };
