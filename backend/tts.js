// Shared TTS language resolution.
//
// The UI already sends an explicit language choice with every voice turn.
// That explicit preference should win over stray Kannada/Hindi characters in
// the response text, such as a worker name or service label.

function normalizeRequestedLanguage(lang) {
    const normalized = String(lang || '').trim().toLowerCase();
    if (!normalized) return null;

    if (normalized.startsWith('kn') || normalized.startsWith('kan')) return 'kn';
    if (normalized.startsWith('hi') || normalized.startsWith('hn') || normalized.startsWith('hin')) return 'hi';
    if (normalized.startsWith('en')) return 'en';
    return null;
}

function countScriptChars(text, pattern) {
    const matches = String(text || '').match(pattern);
    return matches ? matches.length : 0;
}

function inferLanguageFromText(text) {
    const content = String(text || '');
    const kannadaChars = countScriptChars(content, /[\u0C80-\u0CFF]/gu);
    const hindiChars = countScriptChars(content, /[\u0900-\u097F]/gu);
    const latinChars = countScriptChars(content, /[A-Za-z]/g);

    if (!kannadaChars && !hindiChars) return 'en';

    const totalChars = kannadaChars + hindiChars + latinChars;
    if (!totalChars) return 'en';

    const dominantChars = Math.max(kannadaChars, hindiChars);
    const dominantLanguage = kannadaChars >= hindiChars ? 'kn' : 'hi';

    // Only switch away from English when the response is clearly dominated by
    // a native-script sentence. Mixed responses with a Kannada/Hindi name plus
    // English directions should stay in English.
    if (dominantChars / totalChars >= 0.55 && dominantChars >= 6) {
        return dominantLanguage;
    }

    return 'en';
}

function resolveTtsLanguage(text, requestedLang) {
    return normalizeRequestedLanguage(requestedLang) || inferLanguageFromText(text);
}

module.exports = {
    normalizeRequestedLanguage,
    inferLanguageFromText,
    resolveTtsLanguage
};
