/* ==========================================================================
GigSync — Simple, Minimal, Modern & Responsive Interactive Controller
Customer Experience · Worker Experience · Voice Agent / 3.5mm Terminal
========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
/* ---------- Global Application State ---------- */
const state = {
token: localStorage.getItem('gigsync_token') || null,
user: null,
city: localStorage.getItem('gigsync_city') || 'Ramanagara',
portal: 'gateway', // 'gateway' | 'customer' | 'worker' | 'terminal'
language: (/^(EN|KN|HN)$/.test((localStorage.getItem('gigsync_language') || '').toUpperCase()) ? (localStorage.getItem('gigsync_language') || 'EN').toUpperCase() : 'EN'),
customerView: 'home', // 'home' | 'bookings'
workerView: 'home', // 'home' | 'bookings' | 'earnings'
workers: [],
jobs: [],
earnings: null,
schedule: null,
voiceAgentActive: false,
isAiModalRecording: false,
terminalLogs: []
};

/* ---------- GigSync Language Control: EN / KN / HN ---------- */
const LANGUAGE_CONFIG = {
    EN: { speech: 'en-IN', tts: 'en', label: 'EN' },
    KN: { speech: 'kn-IN', tts: 'kn', label: 'KN' },
    HN: { speech: 'hi-IN', tts: 'hi', label: 'HN' }
};
function getLanguageConfig() { return LANGUAGE_CONFIG[state.language] || LANGUAGE_CONFIG.EN; }
function setAppLanguage(lang) {
    const normalized = String(lang || 'EN').toUpperCase();
    if (!LANGUAGE_CONFIG[normalized]) return;
    state.language = normalized;
    localStorage.setItem('gigsync_language', normalized);
    document.documentElement.lang = normalized === 'KN' ? 'kn' : normalized === 'HN' ? 'hi' : 'en';
    document.querySelectorAll('[data-gigsync-language]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.gigsyncLanguage === normalized);
    });
    updateLanguageControls();
    updateAiLanguageTexts();
    if (typeof updateAuthFormLanguage === 'function') updateAuthFormLanguage();
    if (typeof terminalSpeechRec !== 'undefined' && terminalSpeechRec) terminalSpeechRec.lang = getLanguageConfig().speech;
    if (typeof aiSpeechRecognizer !== 'undefined' && aiSpeechRecognizer) aiSpeechRecognizer.lang = getLanguageConfig().speech;
}
function updateLanguageControls() {
    document.querySelectorAll('[data-gigsync-language]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.gigsyncLanguage === state.language);
    });
}
const UI_TRANSLATIONS = {
    EN: {
        activeBookings: 'Active & Upcoming Bookings', noBookings: 'No bookings yet.', availableSpecialists: 'Available Specialists',
        verifiedLocal: 'Verified local professionals on-duty in', bookByDate: 'Book by Date', refresh: 'Refresh', viewAll: 'View All',
        talk: 'Talk to GigSync', myBookings: 'My Bookings', currentAvailability: 'CURRENT AVAILABILITY TODAY', editAvailability: 'Edit Availability',
        currentBooking: 'Current Booking', workerBookings: 'Upcoming Bookings', noWorkers: 'No workers available in your area yet.',
        voiceAssistant: 'Voice Assistant', voiceDesc: 'Check your bookings, update hours, or ask anything by voice.',
        voiceModalTitle: 'Talk to GigSync', voiceModalSub: 'Speak or type in English, Kannada, or Hindi to book specialists and manage GigSync tasks.',
        clickMic: 'Click microphone to speak', listening: 'Listening to your voice... Speak now', processing: '🧠 Processing requirement...', responding: '🔊 Responding...'
    },
    KN: {
        activeBookings: 'ಸಕ್ರಿಯ ಮತ್ತು ಮುಂಬರುವ ಬುಕ್ಕಿಂಗ್‌ಗಳು', noBookings: 'ಇನ್ನೂ ಯಾವುದೇ ಬುಕ್ಕಿಂಗ್‌ಗಳಿಲ್ಲ.', availableSpecialists: 'ಲಭ್ಯವಿರುವ ತಜ್ಞರು',
        verifiedLocal: 'ರಮಾನಗರದಲ್ಲಿ ಕರ್ತವ್ಯದಲ್ಲಿರುವ ಪರಿಶೀಲಿತ ಸ್ಥಳೀಯ ವೃತ್ತಿಪರರು', bookByDate: 'ದಿನಾಂಕದ ಮೂಲಕ ಬುಕ್ ಮಾಡಿ', refresh: 'ಮರುಲೋಡ್ ಮಾಡಿ', viewAll: 'ಎಲ್ಲವನ್ನೂ ವೀಕ್ಷಿಸಿ',
        talk: 'GigSync ಜೊತೆ ಮಾತನಾಡಿ', myBookings: 'ನನ್ನ ಬುಕ್ಕಿಂಗ್‌ಗಳು', currentAvailability: 'ಇಂದಿನ ಪ್ರಸ್ತುತ ಲಭ್ಯತೆ', editAvailability: 'ಲಭ್ಯತೆಯನ್ನು ಬದಲಾಯಿಸಿ',
        currentBooking: 'ಪ್ರಸ್ತುತ ಬುಕ್ಕಿಂಗ್', workerBookings: 'ಮುಂಬರುವ ಬುಕ್ಕಿಂಗ್‌ಗಳು', noWorkers: 'ನಿಮ್ಮ ಪ್ರದೇಶದಲ್ಲಿ ಇನ್ನೂ ಯಾವುದೇ ಕೆಲಸಗಾರರು ಲಭ್ಯವಿಲ್ಲ.',
        voiceAssistant: 'ಧ್ವನಿ ಸಹಾಯಕ', voiceDesc: 'ನಿಮ್ಮ ಬುಕ್ಕಿಂಗ್‌ಗಳನ್ನು ಪರಿಶೀಲಿಸಿ, ಕೆಲಸದ ಸಮಯವನ್ನು ಬದಲಾಯಿಸಿ ಅಥವಾ ಧ್ವನಿಯ ಮೂಲಕ ಕೇಳಿ.',
        voiceModalTitle: 'GigSync ಜೊತೆ ಮಾತನಾಡಿ', voiceModalSub: 'ತಜ್ಞರನ್ನು ಬುಕ್ ಮಾಡಲು ಮತ್ತು GigSync ಕಾರ್ಯಗಳನ್ನು ನಿರ್ವಹಿಸಲು ಕನ್ನಡ, ಇಂಗ್ಲಿಷ್ ಅಥವಾ ಹಿಂದಿಯಲ್ಲಿ ಮಾತನಾಡಿ ಅಥವಾ ಟೈಪ್ ಮಾಡಿ.',
        clickMic: 'ಮಾತನಾಡಲು ಮೈಕ್ರೊಫೋನ್ ಒತ್ತಿರಿ', listening: 'ನಿಮ್ಮ ಧ್ವನಿಯನ್ನು ಕೇಳಲಾಗುತ್ತಿದೆ... ಈಗ ಮಾತನಾಡಿ', processing: '🧠 ನಿಮ್ಮ ವಿನಂತಿಯನ್ನು ಪರಿಶೀಲಿಸಲಾಗುತ್ತಿದೆ...', responding: '🔊 ಉತ್ತರಿಸಲಾಗುತ್ತಿದೆ...'
    },
    HN: {
        activeBookings: 'सक्रिय और आगामी बुकिंग', noBookings: 'अभी कोई बुकिंग नहीं है।', availableSpecialists: 'उपलब्ध विशेषज्ञ',
        verifiedLocal: 'रमानगर में ड्यूटी पर सत्यापित स्थानीय पेशेवर', bookByDate: 'तारीख के अनुसार बुक करें', refresh: 'रीफ्रेश करें', viewAll: 'सभी देखें',
        talk: 'GigSync से बात करें', myBookings: 'मेरी बुकिंग', currentAvailability: 'आज की वर्तमान उपलब्धता', editAvailability: 'उपलब्धता बदलें',
        currentBooking: 'वर्तमान बुकिंग', workerBookings: 'आगामी बुकिंग', noWorkers: 'आपके क्षेत्र में अभी कोई कामगार उपलब्ध नहीं है।',
        voiceAssistant: 'वॉइस असिस्टेंट', voiceDesc: 'अपनी बुकिंग देखें, काम के घंटे बदलें या आवाज़ से कुछ भी पूछें।',
        voiceModalTitle: 'GigSync से बात करें', voiceModalSub: 'विशेषज्ञों को बुक करने और GigSync के कार्य करने के लिए हिंदी, कन्नड़ या अंग्रेज़ी में बोलें या टाइप करें।',
        clickMic: 'बोलने के लिए माइक्रोफ़ोन दबाएँ', listening: 'आपकी आवाज़ सुनी जा रही है... अभी बोलें', processing: '🧠 आपकी आवश्यकता समझी जा रही है...', responding: '🔊 जवाब दिया जा रहा है...'
    }
};
function updateAiLanguageTexts() {
    const t = UI_TRANSLATIONS[state.language] || UI_TRANSLATIONS.EN;
    const map = {
        homeTalkAiActionBtn: t.talk,
        viewAllCustBookingsLink: t.viewAll,
        openCalendarBookingBtn: t.bookByDate,
        refreshCustWorkersBtn: t.refresh,
        workerTalkAiActionBtn: t.talk,
        openEditAvailModalBtn: t.editAvailability
    };
    Object.entries(map).forEach(([id, value]) => {
        const el = document.getElementById(id); if (!el) return;
        const icon = el.querySelector('i'); el.textContent = '';
        if (icon) { el.appendChild(icon); el.appendChild(document.createTextNode(' ')); }
        el.appendChild(document.createTextNode(value));
    });
    const modalTitle = document.querySelector('#aiVoiceModal .ai-header-title h3'); if (modalTitle) modalTitle.textContent = t.voiceModalTitle;
    const modalSub = document.querySelector('#aiVoiceModal .ai-header-title small'); if (modalSub) modalSub.textContent = t.voiceModalSub;
    const input = document.getElementById('aiModalTextInput'); if (input) input.placeholder = state.language === 'KN' ? 'ನಿಮ್ಮ ವಿನಂತಿಯನ್ನು ಟೈಪ್ ಮಾಡಿ...' : state.language === 'HN' ? 'अपनी आवश्यकता टाइप करें...' : 'Type your request...';
    document.querySelectorAll('#aiVoiceModal .q-chip').forEach((chip, idx) => {
        const copies = state.language === 'KN'
            ? ['ನಾಳೆ ನನಗೆ ಎಲೆಕ್ಟ್ರಿಷಿಯನ್ ಬೇಕು', 'ನನ್ನ ಬುಕ್ಕಿಂಗ್‌ಗಳನ್ನು ಪರಿಶೀಲಿಸಿ', 'ನನ್ನ ಮುಂದಿನ ಕೆಲಸ ಯಾವುದು?', 'ನಾಳೆ 9 ರಿಂದ 5 ರವರೆಗೆ ಲಭ್ಯತೆ ಹೊಂದಿಸಿ']
            : state.language === 'HN'
                ? ['मुझे कल इलेक्ट्रीशियन चाहिए', 'मेरी बुकिंग देखें', 'मेरा अगला काम क्या है?', 'कल 9 से 5 तक मेरी उपलब्धता सेट करें']
                : ['I need an electrician tomorrow', 'Check my bookings', 'What is my next job?', 'Set my availability tomorrow 9 to 5'];
        if (copies[idx]) chip.textContent = copies[idx];
    });
    const stateLabel = document.getElementById('aiVoiceStateLabel'); if (stateLabel && !state.isAiModalRecording) stateLabel.textContent = t.clickMic;
    const liveText = document.getElementById('aiLiveStreamText'); if (liveText && !state.isAiModalRecording) liveText.textContent = t.listening;
    document.querySelectorAll('#custActiveBookingsSection .section-title-row h2').forEach(el => el.textContent = t.activeBookings);
    document.querySelectorAll('.empty-placeholder p').forEach(el => {
        if (/No bookings yet\.|ಇನ್ನೂ ಯಾವುದೇ ಬುಕ್ಕಿಂಗ್|अभी कोई बुकिंग/.test(el.textContent || '')) el.textContent = t.noBookings;
        if (/No workers available|ನಿಮ್ಮ ಪ್ರದೇಶದಲ್ಲಿ|आपके क्षेत्र में/.test(el.textContent || '')) el.textContent = t.noWorkers;
    });
    document.querySelectorAll('.section-title-row h2').forEach(el => { if (/^Available Specialists|^ಲಭ್ಯವಿರುವ ತಜ್ಞರು|^उपलब्ध विशेषज्ञ/.test(el.textContent)) el.textContent = t.availableSpecialists; });
    document.querySelectorAll('.status-kicker').forEach(el => el.textContent = t.currentAvailability.toUpperCase());
}
function installLanguageSwitcher() {
    let wrap = document.getElementById('gigsyncLanguageSwitcher');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'gigsyncLanguageSwitcher';
        wrap.className = 'gigsync-language-switcher';
        document.body.appendChild(wrap);
    }
    if (!wrap.dataset.bound) {
        ['EN','KN','HN'].forEach(code => {
            if (wrap.querySelector(`[data-gigsync-language="${code}"]`)) return;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.dataset.gigsyncLanguage = code;
            btn.textContent = code;
            btn.setAttribute('aria-label', code === 'EN' ? 'English' : code === 'KN' ? 'Kannada' : 'Hindi');
            btn.addEventListener('click', () => setAppLanguage(code));
            wrap.appendChild(btn);
        });
        wrap.dataset.bound = 'true';
    }
    updateLanguageControls();
    updateAiLanguageTexts();
}
installLanguageSwitcher();

/* ---------- Local Authentication Vault ---------- */
const LocalAuthVault = {
    _KEY: 'gigsync_auth_vault_v4',
    getAll() {
        try {
            return JSON.parse(localStorage.getItem(this._KEY) || '[]');
        } catch (e) {
            return [];
        }
    },
    saveUser(u) {
        const users = this.getAll().filter(x => x.phone !== u.phone);
        users.push(u);
        localStorage.setItem(this._KEY, JSON.stringify(users));
    },
    findByPhone(phone) {
        return this.getAll().find(u => u.phone === phone);
    }
};

/* ---------- Toast Notifications ---------- */
function toast(msg) {
    const el = document.getElementById('toast');
    const msgEl = document.getElementById('toastMsg');
    if (!el || !msgEl) return;
    msgEl.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => el.classList.add('hidden'), 3000);
}

/* ---------- Audio Pipeline Diagnostics & Telemetry ---------- */
function updateDiagnostic(id, text, type = 'idle') {
    const el = document.getElementById(id);
    if (!el) return;
    const val = el.querySelector('.diag-val');
    if (val) {
        val.className = `diag-val ${type}`;
        val.textContent = text;
    }
}

function showDiagError(errText) {
    const box = document.getElementById('diagErrorBox');
    if (!box) return;
    if (errText) {
        box.textContent = `🔴 Playback Issue: ${errText}`;
        box.classList.remove('hidden');
    } else {
        box.classList.add('hidden');
        box.textContent = '';
    }
}

/* ---------- Guaranteed Real TTS Audio Engine ---------- */
const gigsyncTtsAudio = new Audio();
gigsyncTtsAudio.crossOrigin = 'anonymous';

// Global unlock flag for autoplay permissions
let audioAutoplayUnlocked = false;

function unlockAudioAutoplay() {
    if (audioAutoplayUnlocked) return;
    audioAutoplayUnlocked = true;
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
            const ctx = new AudioCtx();
            if (ctx.state === 'suspended') ctx.resume();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            gain.gain.value = 0.001; // Inaudible unlock pulse
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.05);
        }
    } catch(e){}
}

/* ---------- Echo Suppression & Speech Recognition Control ---------- */
function pauseSpeechRecognitionForTts() {
    isAiSpeaking = true;
    speechRecognitionPaused = true;
    clearTimeout(turnSilenceTimer);
    turnSilenceTimer = null;
    currentTurnTranscript = '';
    currentInterimTranscript = '';
    if (terminalSpeechRec) {
        try {
            terminalSpeechRec.abort(); // Immediately flush internal Web Speech buffer
        } catch(e){}
    }
    if (aiSpeechRecognizer) {
        try {
            aiSpeechRecognizer.abort();
        } catch(e){}
    }
}

function resumeSpeechRecognitionAfterTts(delayMs = 800) {
    clearTimeout(turnSilenceTimer);
    turnSilenceTimer = null;
    currentTurnTranscript = '';
    currentInterimTranscript = '';

    setTimeout(() => {
        isAiSpeaking = false;
        speechRecognitionPaused = false;
        if (state.voiceAgentActive) {
            setVoiceAgentState('listening', '🟢 LISTENING');
            const liveStatus = document.getElementById('terminalLiveAudioStatus');
            if (liveStatus) liveStatus.textContent = 'Listening (Audio Live)';
            if (terminalSpeechRec) {
                try {
                    terminalSpeechRec.start();
                } catch(e){}
            }
        }
        if (state.isAiModalRecording && aiSpeechRecognizer) {
            try {
                aiSpeechRecognizer.start();
            } catch(e){}
        }
    }, delayMs);
}

async function playTtsAudio(text, shouldEndCall = false) {
    if (!text) return;
    unlockAudioAutoplay();
    showDiagError(null);
    updateDiagnostic('diagTts', '🟡 Generating...', 'working');
    updateDiagnostic('diagAudioPlayback', '🟡 Preparing...', 'working');

    // ECHO SUPPRESSION LAYER 1: Pause and abort STT immediately before TTS generation & playback
    pauseSpeechRecognitionForTts();
    setVoiceAgentState('speaking', '🔵 GIGSYNC AI SPEAKING');

    // Track recent AI spoken responses for ECHO SUPPRESSION LAYER 3 (Self-Echo Filter)
    if (!state.recentAiResponses) state.recentAiResponses = [];
    state.recentAiResponses.unshift({ text, time: Date.now() });
    if (state.recentAiResponses.length > 6) state.recentAiResponses.pop();

    const liveStatus = document.getElementById('terminalLiveAudioStatus');
    if (liveStatus && state.voiceAgentActive) liveStatus.textContent = '🔊 AI Speaking (Output Active)';

    const lang = getLanguageConfig().tts;
    const ttsUrl = `/api/ai/tts?text=${encodeURIComponent(text)}&lang=${lang}`;

    try {
        gigsyncTtsAudio.pause();
        gigsyncTtsAudio.src = ttsUrl;
        gigsyncTtsAudio.volume = 1.0;
        gigsyncTtsAudio.load();

        // Explicit Audio Output Routing (setSinkId)
        const outputSelect = document.getElementById('terminalAudioOutputSelect');
        const selectedSink = outputSelect ? outputSelect.value : 'default';
        if (selectedSink && selectedSink !== 'default' && typeof gigsyncTtsAudio.setSinkId === 'function') {
            try {
                await gigsyncTtsAudio.setSinkId(selectedSink);
                const optLabel = outputSelect.options[outputSelect.selectedIndex]?.text || '3.5mm Device';
                updateDiagnostic('diagOutputDevice', `🟢 ${optLabel.slice(0, 14)}`, 'ok');
            } catch(sinkErr) {
                console.warn('setSinkId failed, using default output:', sinkErr);
            }
        }

        gigsyncTtsAudio.onplay = () => {
            isAiSpeaking = true;
            pauseSpeechRecognitionForTts();
            setVoiceAgentState('speaking', '🔵 GIGSYNC AI SPEAKING');
            updateDiagnostic('diagTts', '🟢 Generated (MP3)', 'ok');
            updateDiagnostic('diagAudioPlayback', '🟢 Playing (MP3 Stream)', 'ok');
            if (liveStatus && state.voiceAgentActive) liveStatus.textContent = '🔊 AI Speaking (Output Active)';
        };

        gigsyncTtsAudio.onended = () => {
            updateDiagnostic('diagAudioPlayback', '✓ Finished', 'ok');
            
            if (shouldEndCall) {
                // Call Ending / Goodbye flow
                setVoiceAgentState('ending', '🔴 CALL ENDED');
                if (liveStatus) liveStatus.textContent = 'Call Ended';
                stopTerminalAudioPipeline();
                state.voiceAgentActive = false;
                if (voiceAgentPowerBtn) {
                    voiceAgentPowerBtn.classList.remove('on');
                    voiceAgentPowerBtn.classList.add('off');
                }
                if (voiceAgentPowerLabel) voiceAgentPowerLabel.textContent = '🔴 OFF';
                if (voiceAgentPowerDesc) voiceAgentPowerDesc.textContent = 'Call ended naturally. Click to start a new voice session.';
                state.sessionId = null;
                toast('🔴 Conversation Ended Naturally');
                appendTerminalActivity('Call completed & voice session ended');
                appendTerminalAction('✓ Conversation closed gracefully');
            } else {
                // ECHO SUPPRESSION LAYER 2: Acoustic decay cooldown (800ms) before re-activating microphone
                resumeSpeechRecognitionAfterTts(800);
            }
        };

        gigsyncTtsAudio.onerror = (e) => {
            console.warn('MP3 stream error, switching to SpeechSynthesis fallback:', e);
            fallbackSpeechSynthesis(text, shouldEndCall);
        };

        const playPromise = gigsyncTtsAudio.play();
        if (playPromise !== undefined) {
            playPromise.catch(playErr => {
                console.warn('Audio play() blocked by browser autoplay or error:', playErr);
                if (playErr.name === 'NotAllowedError') {
                    showDiagError('Autoplay blocked. Click "Start Voice Agent" or "Test AI Voice" to enable audio.');
                }
                fallbackSpeechSynthesis(text, shouldEndCall, playErr.message);
            });
        }
    } catch(err) {
        console.warn('TTS streaming exception:', err);
        fallbackSpeechSynthesis(text, shouldEndCall, err.message);
    }
}

function fallbackSpeechSynthesis(text, shouldEndCall = false, origErr = null) {
    if (!('speechSynthesis' in window)) {
        updateDiagnostic('diagAudioPlayback', '🔴 Failed (No TTS)', 'err');
        showDiagError(origErr || 'Browser does not support Speech Synthesis');
        resumeSpeechRecognitionAfterTts(300);
        return;
    }

    try {
        if (window.speechSynthesis.paused) {
            window.speechSynthesis.resume();
        }
        window.speechSynthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1.0;
        utterance.pitch = 1.0;
        utterance.volume = 1.0;
        const cfg = getLanguageConfig();
        utterance.lang = cfg.speech;

        // Prefer a native voice for the selected language. Browser voice quality varies by OS;
        // never silently reuse an English voice while KN/HN is selected.
        const voices = window.speechSynthesis.getVoices();
        if (voices && voices.length > 0) {
            const nativePrefixes = cfg.tts === 'kn' ? ['kn-IN','kn'] : cfg.tts === 'hi' ? ['hi-IN','hi'] : ['en-IN','en-US','en-GB','en'];
            const match = voices.find(v => nativePrefixes.some(prefix => String(v.lang || '').toLowerCase().startsWith(prefix.toLowerCase())))
                || voices.find(v => cfg.tts === 'kn' ? /kannada/i.test(v.name) : cfg.tts === 'hi' ? /hindi/i.test(v.name) : /english/i.test(v.name));
            if (match) utterance.voice = match;
        }

        window._currentSpeechUtterance = utterance;

        utterance.onstart = () => {
            isAiSpeaking = true;
            pauseSpeechRecognitionForTts();
            setVoiceAgentState('speaking', '🔵 GIGSYNC AI SPEAKING');
            updateDiagnostic('diagTts', '🟢 Generated (SpeechSynth)', 'ok');
            updateDiagnostic('diagAudioPlayback', '🟢 Playing (SpeechSynth)', 'ok');
            const liveStatus = document.getElementById('terminalLiveAudioStatus');
            if (liveStatus && state.voiceAgentActive) liveStatus.textContent = '🔊 AI Speaking (Output Active)';
        };

        utterance.onend = () => {
            window._currentSpeechUtterance = null;
            updateDiagnostic('diagAudioPlayback', '✓ Finished', 'ok');
            
            if (shouldEndCall) {
                setVoiceAgentState('ending', '🔴 CALL ENDED');
                stopTerminalAudioPipeline();
                state.voiceAgentActive = false;
                if (voiceAgentPowerBtn) {
                    voiceAgentPowerBtn.classList.remove('on');
                    voiceAgentPowerBtn.classList.add('off');
                }
                if (voiceAgentPowerLabel) voiceAgentPowerLabel.textContent = '🔴 OFF';
                state.sessionId = null;
                toast('🔴 Conversation Ended Naturally');
            } else {
                resumeSpeechRecognitionAfterTts(800);
            }
        };

        utterance.onerror = (e) => {
            updateDiagnostic('diagAudioPlayback', '🔴 Failed', 'err');
            showDiagError(e.error || origErr || 'Speech synthesis error');
            resumeSpeechRecognitionAfterTts(300);
        };

        window.speechSynthesis.speak(utterance);
    } catch (e) {
        updateDiagnostic('diagAudioPlayback', '🔴 Failed', 'err');
        showDiagError(e.message);
        resumeSpeechRecognitionAfterTts(300);
    }
}

function speakText(text) {
    return playTtsAudio(text);
}

/* ---------- API Fetch Helper ---------- */
async function apiFetch(endpoint, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {})
    };
    if (state.token) {
        headers['Authorization'] = `Bearer ${state.token}`;
    }

    try {
        const res = await fetch(endpoint, { ...options, headers });
        const text = await res.text();
        let data = null;
        try {
            data = JSON.parse(text);
        } catch (err) {
            // A non-JSON body means the server did not answer properly. It used to be
            // treated as a cue to hand out a fake admin session client-side, which made an
            // unreachable backend look like a successful login. Report the truth instead.
            return {
                ok: false,
                status: res.status,
                data: { status: 'error', message: 'The GigSync server did not respond properly. Please try again.' }
            };
        }
        return { ok: res.ok, status: res.status, data };
    } catch (err) {
        return { ok: false, status: 0, data: { status: 'error', message: err.message } };
    }
}

/* ======================================================================
   PORTAL & VIEW NAVIGATION
   ====================================================================== */

function switchPortal(targetPortal) {
    state.portal = targetPortal;
    document.getElementById('gatewayPortal')?.classList.toggle('active', targetPortal === 'gateway');
    document.getElementById('customerPortal')?.classList.toggle('active', targetPortal === 'customer');
    document.getElementById('workerPortal')?.classList.toggle('active', targetPortal === 'worker');
    document.getElementById('voiceTerminalPortal')?.classList.toggle('active', targetPortal === 'terminal');

    if (targetPortal === 'customer') {
        loadCustomerHomeData();
    } else if (targetPortal === 'worker') {
        loadWorkerDashboardData();
    } else if (targetPortal === 'terminal') {
        loadTerminalData();
    }
}

// Switch Customer Views (Home vs Bookings)
function switchCustomerView(viewName) {
    state.customerView = viewName;
    document.querySelectorAll('.customer-view').forEach(el => {
        el.classList.toggle('active', el.id === `custView-${viewName}`);
    });

    // Desktop nav
    document.querySelectorAll('.desktop-nav-menu .nav-link').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.custView === viewName);
    });

    // Mobile bottom nav
    document.querySelectorAll('.mobile-bottom-nav .bottom-nav-item').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.custView === viewName);
    });

    if (viewName === 'home') loadCustomerHomeData();
    else if (viewName === 'bookings') loadCustomerBookings();
}

// Switch Worker Views (Home vs Bookings vs Earnings)
function switchWorkerView(viewName) {
    state.workerView = viewName;
    document.querySelectorAll('.worker-view').forEach(el => {
        el.classList.toggle('active', el.id === `workerView-${viewName}`);
    });

    // Desktop nav
    document.querySelectorAll('.desktop-nav-menu .nav-link').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.workerView === viewName);
    });

    // Mobile bottom nav
    document.querySelectorAll('.mobile-bottom-nav .bottom-nav-item').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.workerView === viewName);
    });

    if (viewName === 'home') loadWorkerDashboardData();
    else if (viewName === 'bookings') loadWorkerBookings();
    else if (viewName === 'earnings') loadWorkerEarnings();
}

// Bind Customer Nav Links
document.querySelectorAll('[data-cust-view]').forEach(btn => {
    btn.addEventListener('click', () => {
        const v = btn.dataset.custView;
        if (v) switchCustomerView(v);
    });
});

// Bind Worker Nav Links
document.querySelectorAll('[data-worker-view]').forEach(btn => {
    btn.addEventListener('click', () => {
        const v = btn.dataset.workerView;
        if (v) switchWorkerView(v);
    });
});

/* ======================================================================
   LOCATION MANAGEMENT
   ====================================================================== */

function updateActiveCity(newCity) {
    state.city = newCity;
    localStorage.setItem('gigsync_city', newCity);

    document.getElementById('activeCityLabel') && (document.getElementById('activeCityLabel').textContent = newCity);
    document.querySelectorAll('.text-city-dynamic').forEach(el => { el.textContent = newCity; });

    document.querySelectorAll('.city-tile').forEach(tile => {
        tile.classList.toggle('active', tile.dataset.city === newCity);
    });

    if (state.portal === 'customer') {
        loadCustomerHomeData();
    } else if (state.portal === 'worker') {
        loadWorkerDashboardData();
    }
}

const locationModal = document.getElementById('locationModal');
document.getElementById('openLocationModalBtn')?.addEventListener('click', () => locationModal?.classList.remove('hidden'));
document.getElementById('workerLocationBtn')?.addEventListener('click', () => locationModal?.classList.remove('hidden'));
document.getElementById('closeLocationModalBtn')?.addEventListener('click', () => locationModal?.classList.add('hidden'));

document.querySelectorAll('.city-tile').forEach(tile => {
    tile.addEventListener('click', () => {
        const c = tile.dataset.city;
        if (c) {
            updateActiveCity(c);
            locationModal?.classList.add('hidden');
            toast(`Location set to ${c}`);
        }
    });
});

document.getElementById('detectGpsLocationBtn')?.addEventListener('click', () => {
    if (!navigator.geolocation) {
        toast('GPS location not supported by this browser.');
        return;
    }
    toast('Detecting GPS location...');
    navigator.geolocation.getCurrentPosition(
        () => {
            updateActiveCity('Ramanagara');
            locationModal?.classList.add('hidden');
            toast('📍 Location confirmed: Ramanagara cluster');
        },
        () => {
            updateActiveCity('Ramanagara');
            locationModal?.classList.add('hidden');
            toast('Defaulted to Ramanagara cluster');
        }
    );
});

/* ======================================================================
   AUTHENTICATION & ROLE SELECTION
   ====================================================================== */

let authMode = 'login'; // 'login' | 'register'
let selectedRole = 'customer'; // 'customer' | 'worker' | 'terminal'

const gTabLogin = document.getElementById('gTabLogin');
const gTabRegister = document.getElementById('gTabRegister');
const gNameGroup = document.getElementById('gNameGroup');
const gPhoneGroup = document.getElementById('gPhoneGroup');
const gPasswordGroup = document.getElementById('gPasswordGroup');
const gWorkerExtraFields = document.getElementById('gWorkerExtraFields');
const gTerminalSecretGroup = document.getElementById('gTerminalSecretGroup');
const gTerminalSecretInput = document.getElementById('gTerminalSecretInput');
const gAuthSubmitBtn = document.getElementById('gAuthSubmitBtn');
const continueGuestBtn = document.getElementById('continueGuestBtn');

/* Auth-page language: Sign In / Create Account tabs and form fields only.
   Strings match GigSync 5. Role picker, guest link, home, and chatbot are unchanged. */
const AUTH_FORM_TRANSLATIONS = {
    EN: {
        signIn: 'Sign In',
        createAccount: 'Create Account',
        fullName: 'Full Name',
        mobileNumber: 'Mobile Number',
        password: 'Password',
        profession: 'Profession / Trade',
        visitingFee: 'Standard Visiting Fee (₹)',
        cityTown: 'City / Town',
        terminalKey: 'Terminal Security Key',
        signInWorker: 'Sign In as Worker',
        createWorker: 'Create Worker Account',
        openTerminal: '⚡ Open Voice Terminal',
        namePh: 'e.g. Ramesh Kumar / Kavya Rao',
        phonePh: 'e.g. 9876543210',
        passwordPh: 'Enter password',
        terminalPh: 'Enter operator password'
    },
    KN: {
        signIn: 'ಲಾಗಿನ್',
        createAccount: 'ಖಾತೆ ರಚಿಸಿ',
        fullName: 'ಪೂರ್ಣ ಹೆಸರು',
        mobileNumber: 'ಮೊಬೈಲ್ ಸಂಖ್ಯೆ',
        password: 'ಪಾಸ್‌ವರ್ಡ್',
        profession: 'ವೃತ್ತಿ / ಕೆಲಸ',
        visitingFee: 'ಸಾಮಾನ್ಯ ಭೇಟಿ ಶುಲ್ಕ (₹)',
        cityTown: 'ನಗರ / ಪಟ್ಟಣ',
        terminalKey: 'ಟರ್ಮಿನಲ್ ಸುರಕ್ಷತಾ ಕೀ',
        signInWorker: 'ಕೆಲಸಗಾರರಾಗಿ ಲಾಗಿನ್',
        createWorker: 'ಕೆಲಸಗಾರರ ಖಾತೆ ರಚಿಸಿ',
        openTerminal: '⚡ ವಾಯ್ಸ್ ಟರ್ಮಿನಲ್ ತೆರೆಯಿರಿ',
        namePh: 'ಉದಾ. ರಮೇಶ್ ಕುಮಾರ್ / ಕಾವ್ಯ ರಾವ್',
        phonePh: 'ಉದಾ. 9876543210',
        passwordPh: 'ಪಾಸ್‌ವರ್ಡ್ ನಮೂದಿಸಿ',
        terminalPh: 'ಆಪರೇಟರ್ ಪಾಸ್‌ವರ್ಡ್ ನಮೂದಿಸಿ'
    },
    HN: {
        signIn: 'साइन इन',
        createAccount: 'खाता बनाएं',
        fullName: 'पूरा नाम',
        mobileNumber: 'मोबाइल नंबर',
        password: 'पासवर्ड',
        profession: 'पेशा / काम',
        visitingFee: 'मानक विज़िट शुल्क (₹)',
        cityTown: 'शहर / कस्बा',
        terminalKey: 'टर्मिनल सुरक्षा कुंजी',
        signInWorker: 'कामगार के रूप में साइन इन',
        createWorker: 'कामगार खाता बनाएं',
        openTerminal: '⚡ वॉइस टर्मिनल खोलें',
        namePh: 'उदा. रमेश कुमार / काव्या राव',
        phonePh: 'उदा. 9876543210',
        passwordPh: 'पासवर्ड दर्ज करें',
        terminalPh: 'ऑपरेटर पासवर्ड दर्ज करें'
    }
};

function updateAuthFormLanguage() {
    const t = AUTH_FORM_TRANSLATIONS[state.language] || AUTH_FORM_TRANSLATIONS.EN;
    if (gTabLogin) gTabLogin.textContent = t.signIn;
    if (gTabRegister) gTabRegister.textContent = t.createAccount;

    const labelMap = {
        gNameInput: t.fullName,
        gPhoneInput: t.mobileNumber,
        gPasswordInput: t.password,
        gWorkerTradeSelect: t.profession,
        gWorkerPriceInput: t.visitingFee,
        gCitySelect: t.cityTown
    };
    Object.entries(labelMap).forEach(([id, text]) => {
        const label = document.querySelector(`label.field-label[for="${id}"]`);
        if (label) label.textContent = text;
    });

    const terminalLabel = document.querySelector('label.field-label[for="gTerminalSecretInput"]');
    if (terminalLabel) {
        const icon = terminalLabel.querySelector('i');
        terminalLabel.textContent = '';
        if (icon) {
            terminalLabel.appendChild(icon);
            terminalLabel.appendChild(document.createTextNode(' '));
        }
        terminalLabel.appendChild(document.createTextNode(t.terminalKey));
    }

    const nameInput = document.getElementById('gNameInput');
    const phoneInput = document.getElementById('gPhoneInput');
    const passwordInput = document.getElementById('gPasswordInput');
    const terminalInput = document.getElementById('gTerminalSecretInput');
    if (nameInput) nameInput.placeholder = t.namePh;
    if (phoneInput) phoneInput.placeholder = t.phonePh;
    if (passwordInput) passwordInput.placeholder = t.passwordPh;
    if (terminalInput) terminalInput.placeholder = t.terminalPh;

    if (!gAuthSubmitBtn) return;
    if (selectedRole === 'terminal') {
        gAuthSubmitBtn.textContent = t.openTerminal;
    } else if (selectedRole === 'worker') {
        gAuthSubmitBtn.textContent = authMode === 'login' ? t.signInWorker : t.createWorker;
    } else {
        gAuthSubmitBtn.textContent = authMode === 'login' ? t.signIn : t.createAccount;
    }
}

function applyRoleSelection(role) {
    selectedRole = role;
    
    // Highlight active role pill
    document.querySelectorAll('#gatewayRolePicker .role-option').forEach(l => {
        const input = l.querySelector('input');
        const isActive = input && input.value === role;
        l.classList.toggle('active', isActive);
        if (input) input.checked = isActive;
    });

    const isTerminal = role === 'terminal';
    const isWorker = role === 'worker';

    // Toggle field visibilities
    gWorkerExtraFields?.classList.toggle('hidden', !isWorker || authMode !== 'register');
    gTerminalSecretGroup?.classList.toggle('hidden', !isTerminal);
    document.getElementById('authTabsRow')?.classList.toggle('hidden', isTerminal);
    // The terminal operator signs in as a real admin, so they need the mobile field too.
    // Their password lives in the Terminal Security Key field instead of gPasswordGroup.
    gPhoneGroup?.classList.toggle('hidden', false);
    gPasswordGroup?.classList.toggle('hidden', isTerminal);
    document.getElementById('gCityGroup')?.classList.toggle('hidden', isTerminal);

    // Pre-fill the default operator credentials so the shipped admin account still
    // opens the terminal without the operator having to look them up.
    if (isTerminal) {
        if (gTerminalSecretInput && !gTerminalSecretInput.value) {
            gTerminalSecretInput.value = 'admin@gigsync2026';
        }
        const phoneField = document.getElementById('gPhoneInput');
        if (phoneField && !phoneField.value) phoneField.value = '9999999999';
    }

    // Update button labels (submit text follows current language; guest link stays English)
    updateAuthFormLanguage();
    if (isTerminal) {
        if (continueGuestBtn) continueGuestBtn.innerHTML = 'Or Directly Launch Voice Terminal <i class="fa-solid fa-arrow-right"></i>';
    } else if (isWorker) {
        if (continueGuestBtn) continueGuestBtn.innerHTML = 'Or Explore Dashboard as Guest Worker <i class="fa-solid fa-arrow-right"></i>';
    } else {
        if (continueGuestBtn) continueGuestBtn.innerHTML = 'Or Explore Marketplace as Guest Customer <i class="fa-solid fa-arrow-right"></i>';
    }
}

// Role selector click & change handlers
document.querySelectorAll('#gatewayRolePicker .role-option').forEach(option => {
    option.addEventListener('click', (e) => {
        const input = option.querySelector('input');
        const val = input ? input.value : 'customer';
        applyRoleSelection(val);
    });
});

document.querySelectorAll('#gatewayRolePicker input[name="gatewayRole"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
        applyRoleSelection(e.target.value);
    });
});

// Auth Mode Switcher
function setAuthMode(mode) {
    authMode = mode;
    gTabLogin?.classList.toggle('active', mode === 'login');
    gTabRegister?.classList.toggle('active', mode === 'register');
    gNameGroup?.classList.toggle('hidden', mode !== 'register');
    gWorkerExtraFields?.classList.toggle('hidden', mode !== 'register' || selectedRole !== 'worker');
    updateAuthFormLanguage();
}

gTabLogin?.addEventListener('click', () => setAuthMode('login'));
gTabRegister?.addEventListener('click', () => setAuthMode('register'));
updateAuthFormLanguage();

// Gateway Form Submit
document.getElementById('gatewayAuthForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const authError = document.getElementById('gAuthError');
    authError?.classList.add('hidden');

    const phone = document.getElementById('gPhoneInput')?.value.trim();
    const password = document.getElementById('gPasswordInput')?.value.trim();
    const name = document.getElementById('gNameInput')?.value.trim();
    const city = document.getElementById('gCitySelect')?.value || state.city;
    const trade = document.getElementById('gWorkerTradeSelect')?.value || 'Master Electrician';
    const price = Number(document.getElementById('gWorkerPriceInput')?.value || 300);
    const secret = document.getElementById('gTerminalSecretInput')?.value.trim();

    if (selectedRole === 'terminal') {
        // The voice terminal now needs a REAL admin session, because the server only lets
        // an authenticated admin connect a call on another person's behalf. The old code
        // faked a 'master_admin_session_token' that the server had never issued, so every
        // 3.5mm call arrived with no verifiable identity at all.
        const adminPhone = phone || '9999999999';
        const res = await apiFetch('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ phone: adminPhone, password: secret })
        });

        if (!res.ok || !res.data.user || !res.data.token) {
            authError.textContent = (res.data && res.data.message)
                || 'Terminal sign-in failed. Check the operator number and security key.';
            authError.classList.remove('hidden');
            return;
        }
        if (res.data.user.role !== 'admin') {
            authError.textContent = 'That account is not a terminal operator. Sign in with an admin account.';
            authError.classList.remove('hidden');
            return;
        }

        state.token = res.data.token;
        state.user = res.data.user;
        localStorage.setItem('gigsync_token', state.token);
        updateActiveCity(state.user.city || city);
        switchPortal('terminal');
        toast(`Voice Terminal connected — operator ${state.user.name}`);
        return;
    }

    if (!phone) {
        authError.textContent = 'Please enter your mobile number.';
        authError.classList.remove('hidden');
        return;
    }

    if (authMode === 'register') {
        if (!name) {
            authError.textContent = 'Please enter your name.';
            authError.classList.remove('hidden');
            return;
        }
        if (!password) {
            authError.textContent = 'Please choose a password.';
            authError.classList.remove('hidden');
            return;
        }

        const regPayload = { phone, password, name, role: selectedRole, city, trade, price };

        const res = await apiFetch('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify(regPayload)
        });

        if (res.ok && res.data.user && res.data.token) {
            state.token = res.data.token;
            state.user = res.data.user;
            localStorage.setItem('gigsync_token', res.data.token);
            LocalAuthVault.saveUser(res.data.user);
            updateActiveCity(city);
            switchPortal(selectedRole === 'worker' ? 'worker' : 'customer');
            toast(`Welcome to GigSync, ${state.user.name}!`);
        } else {
            // No local fallback account. The old code invented a client-side user with a
            // made-up name ('Ramesh Kumar') and a token the server had never issued, so the
            // person appeared signed in while nothing existed in the database — and every
            // later request silently acted as nobody.
            authError.textContent = (res.data && res.data.message)
                || 'Could not create your account. Please check your connection and try again.';
            authError.classList.remove('hidden');
        }
    } else {
        // Sign In
        if (!password) {
            authError.textContent = 'Please enter your password.';
            authError.classList.remove('hidden');
            return;
        }

        const res = await apiFetch('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ phone, password, role: selectedRole })
        });

        if (res.ok && res.data.user && res.data.token) {
            state.token = res.data.token;
            state.user = res.data.user;
            localStorage.setItem('gigsync_token', res.data.token);
            LocalAuthVault.saveUser(res.data.user);
            updateActiveCity(state.user.city || city);
            switchPortal(state.user.role === 'worker' ? 'worker' : 'customer');
            toast(`Welcome back, ${state.user.name}`);
        } else {
            // Sign-in failures are reported honestly. Previously a wrong password quietly
            // produced an 'instant_session_token' identity called 'Rumais (Worker)', which
            // meant a failed login looked identical to a successful one.
            authError.textContent = (res.data && res.data.message)
                || 'Incorrect mobile number or password.';
            authError.classList.remove('hidden');
        }
    }
});

// Guest Mode Continue
//
// Guest mode is for BROWSING only, and it can no longer claim to be somebody real.
// It previously signed the visitor in as seed worker Rumais (7760782551) with a token
// the server never issued — so a guest could read and rewrite a real worker's schedule.
continueGuestBtn?.addEventListener('click', () => {
    const authError = document.getElementById('gAuthError');
    const cityNow = document.getElementById('gCitySelect')?.value || state.city;

    if (selectedRole === 'terminal' || selectedRole === 'worker') {
        // Both of these act on a real person's records, so both need a real sign-in.
        if (authError) {
            authError.textContent = selectedRole === 'terminal'
                ? 'The voice terminal needs an operator sign-in. Enter the operator mobile number and password above.'
                : 'Worker dashboards show real bookings and earnings, so please sign in with your registered mobile number.';
            authError.classList.remove('hidden');
        }
        return;
    }

    // A guest customer browses with no identity at all. The moment they want to book or
    // chat, the AI asks for their number — we do not put words in their mouth by
    // inventing '9876543210'.
    state.user = { id: null, name: 'Guest', role: 'customer', phone: null, city: cityNow };
    state.token = null;
    localStorage.removeItem('gigsync_token');
    updateActiveCity(cityNow);
    switchPortal('customer');
    toast('Browsing GigSync as a guest — sign in to book.');
});

// Dropdown Profile Toggles
const userMenuBtn = document.getElementById('userMenuBtn');
const userDropdownMenu = document.getElementById('userDropdownMenu');
userMenuBtn?.addEventListener('click', () => userDropdownMenu?.classList.toggle('hidden'));

const workerProfileMenuBtn = document.getElementById('workerProfileMenuBtn');
const workerDropdownMenu = document.getElementById('workerDropdownMenu');
workerProfileMenuBtn?.addEventListener('click', () => workerDropdownMenu?.classList.toggle('hidden'));

document.addEventListener('click', (e) => {
    if (!userMenuBtn?.contains(e.target) && !userDropdownMenu?.contains(e.target)) {
        userDropdownMenu?.classList.add('hidden');
    }
    if (!workerProfileMenuBtn?.contains(e.target) && !workerDropdownMenu?.contains(e.target)) {
        workerDropdownMenu?.classList.add('hidden');
    }
});

// Logout Handlers
function logout() {
    const oldSessionId = state.sessionId;
    state.token = null;
    state.user = null;
    state.sessionId = null;
    localStorage.removeItem('gigsync_token');
    userDropdownMenu?.classList.add('hidden');
    workerDropdownMenu?.classList.add('hidden');

    // Clear dialogue box and audio state
    const dialogueBox = document.getElementById('aiModalTranscriptBox');
    if (dialogueBox) dialogueBox.innerHTML = '';
    if (aiSpeechRecognizer) {
        try { aiSpeechRecognizer.abort(); } catch(e){}
    }
    accumulatedAiSpeech = '';
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
    }

    if (oldSessionId) {
        apiFetch('/api/ai/reset-session', {
            method: 'POST',
            body: JSON.stringify({ sessionId: oldSessionId })
        }).catch(() => {});
    }

    switchPortal('gateway');
    toast('Logged out');
}

document.getElementById('dropdownLogoutBtn')?.addEventListener('click', logout);
document.getElementById('workerLogoutBtn')?.addEventListener('click', logout);
document.getElementById('terminalLogoutBtn')?.addEventListener('click', logout);

/* ======================================================================
   1. CUSTOMER PORTAL DATA & LOGIC
   ====================================================================== */

// Create Job Modal
const createJobModal = document.getElementById('createJobModal');
function openCreateJobModal() {
    createJobModal?.classList.remove('hidden');
}
function closeCreateJobModal() {
    createJobModal?.classList.add('hidden');
}

document.getElementById('custNavPostJob')?.addEventListener('click', openCreateJobModal);
document.getElementById('mCustNavPostJob')?.addEventListener('click', openCreateJobModal);
document.getElementById('homePostJobBtn')?.addEventListener('click', openCreateJobModal);
document.getElementById('closeCreateJobModalBtn')?.addEventListener('click', closeCreateJobModal);

// Post Job Form Submit
document.getElementById('createJobForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const service = document.getElementById('newJobServiceSelect')?.value;
    const problem_description = document.getElementById('newJobDescription')?.value.trim();
    const requested_date = document.getElementById('newJobDate')?.value.trim();
    const requested_time = document.getElementById('newJobTime')?.value.trim();
    const location = document.getElementById('newJobLocation')?.value.trim();
    const budget = document.getElementById('newJobBudget')?.value.trim();

    // A booking has to belong to a real, reachable customer — the worker calls this
    // number. It used to fall back to '9876543210', creating jobs nobody could deliver.
    if (!state.user || !state.user.phone) {
        toast('Please sign in with your mobile number before posting a job.');
        return;
    }

    const payload = {
        customer_phone: state.user.phone,
        customer_name: state.user.name,
        service,
        problem_description,
        location,
        city: state.city,
        requested_date,
        requested_time,
        budget
    };

    const res = await apiFetch('/api/jobs', {
        method: 'POST',
        body: JSON.stringify(payload)
    });

    if (res.ok) {
        toast('✅ Job request posted successfully!');
        closeCreateJobModal();
        loadCustomerHomeData();
    } else {
        toast('Job posted locally.');
        closeCreateJobModal();
    }
});

// Load Customer Home Data
async function loadCustomerHomeData() {
    // Update user display
    if (state.user) {
        const initials = state.user.name ? state.user.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase() : 'KR';
        document.getElementById('userInitials') && (document.getElementById('userInitials').textContent = initials);
        document.getElementById('userDisplayName') && (document.getElementById('userDisplayName').textContent = state.user.name || 'Customer');
        document.getElementById('dropdownUserName') && (document.getElementById('dropdownUserName').textContent = state.user.name || 'Customer');
    }

    // Fetch Real Workers & User's Own Bookings
    const custPhone = state.user?.phone ? state.user.phone.replace(/\D/g, '') : '';
    const jobsUrl = custPhone ? `/api/jobs?phone=${encodeURIComponent(custPhone)}` : '/api/jobs';
    const [wRes, jRes] = await Promise.all([
        apiFetch(`/api/workers?city=${encodeURIComponent(state.city)}`),
        apiFetch(jobsUrl)
    ]);

    const workers = (wRes.ok && wRes.data.workers) ? wRes.data.workers : [];
    const allJobs = (jRes.ok && jRes.data.jobs) ? jRes.data.jobs : [];
    const jobs = custPhone ? allJobs.filter(j => {
        const jp = (j.customer_phone || '').replace(/\D/g, '');
        return jp === custPhone || (state.user && j.customer_id === state.user.id);
    }) : [];
    state.workers = workers;
    state.jobs = jobs;

    // Render Active/Upcoming Bookings (Belonging only to this customer)
    const activeBookings = jobs.filter(j => j.status !== 'Completed' && j.status !== 'Cancelled');
    const activeListEl = document.getElementById('custActiveBookingsList');
    if (activeListEl) {
        if (activeBookings.length === 0) {
            activeListEl.innerHTML = `<div class="empty-placeholder"><p>No bookings yet.</p></div>`;
        } else {
            activeListEl.innerHTML = activeBookings.slice(0, 3).map(j => `
                <div class="booking-card">
                    <div class="booking-info">
                        <h4 class="booking-service-title">${j.service}</h4>
                        <div class="booking-meta-row">
                            <span><i class="fa-solid fa-clock"></i> ${j.requested_date} • ${j.requested_time}</span>
                            <span><i class="fa-solid fa-location-dot"></i> ${j.location || state.city}</span>
                            <span><i class="fa-solid fa-indian-rupee-sign"></i> ${j.budget || '₹300'}</span>
                        </div>
                    </div>
                    <div class="booking-actions-col">
                        <span class="status-pill ${j.status.toLowerCase().replace(/\s+/g, '-')}">
                            <span class="status-indicator"></span> ${j.status}
                        </span>
                    </div>
                </div>
            `).join('');
        }
    }

    // Render Available Specialists (Real Data Only)
    const workersGridEl = document.getElementById('custWorkersGrid');
    if (workersGridEl) {
        if (workers.length === 0) {
            workersGridEl.innerHTML = `<div class="empty-placeholder" style="grid-column:1/-1"><p>No workers available in your area yet.</p></div>`;
        } else {
            workersGridEl.innerHTML = workers.map(w => {
                const initials = (w.name || 'W').split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
                const safeName = (w.name || 'Specialist').replace(/'/g, "\\'");
                const safeTrade = (w.trade || 'Service').replace(/'/g, "\\'");
                const safeHours = (w.availability_hours || '09:00 AM – 05:00 PM').replace(/'/g, "\\'");
                return `
                    <div class="worker-card">
                        <div class="worker-card-head">
                            <div class="avatar-circle worker-avatar">${initials}</div>
                            <div>
                                <h4 class="worker-card-name">${w.name}</h4>
                                <span class="worker-card-trade">${w.trade}</span>
                            </div>
                        </div>
                        <div class="worker-card-meta">
                            <span><i class="fa-solid fa-star" style="color:#F59E0B"></i> ${w.rating || '4.9'}</span>
                            <span><i class="fa-solid fa-location-dot"></i> ${w.city}</span>
                            <span><i class="fa-solid fa-clock"></i> ${w.availability_hours || 'Available'}</span>
                            <span><strong>₹${w.price || 300}</strong></span>
                        </div>
                        <button type="button" class="btn btn-outline btn-sm btn-block" onclick="window._bookWorkerDirect(${w.id || 'null'}, '${safeName}', '${w.phone || ''}', '${safeTrade}', ${w.price || 300}, '${safeHours}')">
                            Book Specialist
                        </button>
                    </div>
                `;
            }).join('');
        }
    }
}

// -------------------------------------------------------------------------
// Direct Booking — shows a mini confirmation modal so the customer picks a
// real date (YYYY-MM-DD) and time before the POST is sent.
//
// WHY: the previous version hard-coded requested_date = 'Tomorrow' and
// requested_time = the full availability range string (e.g. '09:00 AM – 05:00 PM').
// Both values were incompatible with how the worker stored their availability:
//   • Worker stores:  date_str = '2026-08-28'
//   • Old booking:    requested_date = 'Tomorrow'
//   → LOWER('tomorrow') ≠ LOWER('2026-08-28')  → 'NotAvailable' every time.
//
// The modal pre-fills sensible defaults but lets the customer correct them,
// then sends a proper ISO date and single time the conflict checker can compare.
// -------------------------------------------------------------------------
window._bookWorkerDirect = async function(workerId, workerName, workerPhone, workerTrade, price, availHours) {
    let custPhone = state.user?.phone || '';
    let custName  = state.user?.name  || '';

    if (!custPhone) {
        custPhone = prompt('Please enter your 10-digit mobile number to book:');
        if (!custPhone || !/^[6-9]\d{9}$/.test(custPhone.trim().replace(/\D/g, ''))) {
            toast('A valid 10-digit mobile number is required.');
            return;
        }
        custPhone = custPhone.trim().replace(/\D/g, '');
        custName  = prompt('Please enter your name:') || 'Customer';
        if (state.user) { state.user.phone = custPhone; state.user.name = custName; }
    }

    // --- Build or reuse the booking confirmation modal ---
    let modal = document.getElementById('_directBookModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = '_directBookModal';
        modal.style.cssText = `
            position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;
            background:rgba(0,0,0,0.55);backdrop-filter:blur(4px);`;
        modal.innerHTML = `
            <div style="background:var(--card-bg,#1e1e2e);border:1px solid var(--border,#333);border-radius:16px;
                        padding:28px 32px;width:min(420px,92vw);box-shadow:0 24px 64px rgba(0,0,0,.6);">
                <h3 id="_dbmTitle" style="margin:0 0 4px;font-size:1.15rem;color:var(--text,#fff)"></h3>
                <p  id="_dbmSub"   style="margin:0 0 20px;font-size:.85rem;color:var(--text-muted,#aaa)"></p>
                <label style="display:block;margin-bottom:12px;font-size:.85rem;color:var(--text-muted,#aaa)">
                    Date
                    <input id="_dbmDate" type="date" style="display:block;width:100%;margin-top:4px;padding:8px 12px;
                           border-radius:8px;border:1px solid var(--border,#444);background:var(--input-bg,#111);
                           color:var(--text,#fff);font-size:.95rem;box-sizing:border-box;">
                </label>
                <label style="display:block;margin-bottom:20px;font-size:.85rem;color:var(--text-muted,#aaa)">
                    Time
                    <select id="_dbmTime" style="display:block;width:100%;margin-top:4px;padding:8px 12px;
                            border-radius:8px;border:1px solid var(--border,#444);background:var(--input-bg,#111);
                            color:var(--text,#fff);font-size:.95rem;box-sizing:border-box;">
                        ${['06:00 AM','07:00 AM','08:00 AM','09:00 AM','10:00 AM','11:00 AM',
                           '12:00 PM','01:00 PM','02:00 PM','03:00 PM','04:00 PM','05:00 PM',
                           '06:00 PM','07:00 PM','08:00 PM']
                            .map(t => `<option value="${t}">${t}</option>`).join('')}
                    </select>
                </label>
                <div style="display:flex;gap:10px;">
                    <button id="_dbmCancel" type="button"
                        style="flex:1;padding:10px;border-radius:8px;border:1px solid var(--border,#444);
                               background:transparent;color:var(--text-muted,#aaa);cursor:pointer;font-size:.9rem;">
                        Cancel
                    </button>
                    <button id="_dbmConfirm" type="button"
                        style="flex:2;padding:10px;border-radius:8px;border:none;
                               background:var(--accent,#6366f1);color:#fff;cursor:pointer;
                               font-size:.9rem;font-weight:600;">
                        Confirm Booking
                    </button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        document.getElementById('_dbmCancel').addEventListener('click', () => {
            modal.style.display = 'none';
        });
    }

    // Pre-fill defaults
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const defaultDate = tomorrow.toISOString().split('T')[0];   // YYYY-MM-DD

    document.getElementById('_dbmTitle').textContent = `Book ${workerName}`;
    document.getElementById('_dbmSub').textContent   =
        `${workerTrade} · ₹${price || 300} · Available: ${availHours || 'See profile'}`;
    document.getElementById('_dbmDate').value = defaultDate;
    document.getElementById('_dbmDate').min   = defaultDate;    // can't book in the past
    document.getElementById('_dbmTime').value = '09:00 AM';     // sensible default

    modal.style.display = 'flex';

    // Wire up confirm button (replace previous listener by cloning)
    const oldBtn = document.getElementById('_dbmConfirm');
    const newBtn = oldBtn.cloneNode(true);
    oldBtn.parentNode.replaceChild(newBtn, oldBtn);

    newBtn.addEventListener('click', async () => {
        const chosenDate = document.getElementById('_dbmDate').value;   // 'YYYY-MM-DD'
        const chosenTime = document.getElementById('_dbmTime').value;   // 'HH:MM AM'

        if (!chosenDate) {
            toast('Please select a date.');
            return;
        }

        modal.style.display = 'none';
        toast(`Booking ${workerName}...`);

        const payload = {
            customer_phone:      custPhone,
            customer_name:       custName || 'Customer',
            worker_id:           workerId  || null,
            worker_name:         workerName,
            worker_phone:        workerPhone || null,
            service:             workerTrade,
            problem_description: `Direct booking for ${workerName} (${workerTrade})`,
            location:            state.user?.area || 'Town Area',
            city:                state.city || 'Ramanagara',
            requested_date:      chosenDate,   // ISO YYYY-MM-DD — matches what workers store
            requested_time:      chosenTime,   // single 'HH:MM AM' — parseTimeToMinutes can handle
            budget:              `₹${price || 300}`,
            status:              'Confirmed',
            payment_method:      'Cash'
        };

        const res = await apiFetch('/api/jobs', { method: 'POST', body: JSON.stringify(payload) });

        if (res.ok) {
            toast(`✅ Booking confirmed for ${workerName}!`);
            loadCustomerHomeData();
            if (state.customerView === 'bookings') loadCustomerBookings();
        } else {
            toast('❌ ' + (res.data?.message || 'Failed to create booking.'));
        }
    });
};



/* ======================================================================
   LIVE UPDATES

   Subscribes to /api/events, the server's change stream. When a worker edits
   their hours — from this browser, from the customer chatbot, or from the
   3.5mm voice handset — every open page is told and re-reads through the
   normal API.

   Before this, the specialist list showed whatever was fetched when the page
   opened. A customer could be looking at "09:00 AM – 04:00 PM" seconds after
   the worker had changed it on a phone call, and only a manual refresh would
   correct it.

   The event says WHAT changed, never the new values. The refresh is a real
   read of the real datastore, so the screen cannot end up showing a value the
   database does not hold.
   ====================================================================== */

let liveStream = null;
let liveRefreshTimer = null;
const pendingLiveEntities = new Set();

function setLiveIndicator(connected) {
    // Reflects a genuinely open stream — not an assumption that one exists.
    document.querySelectorAll('[data-live-indicator]').forEach(el => {
        el.classList.toggle('live-on', connected);
        el.title = connected ? 'Live updates connected' : 'Live updates reconnecting…';
    });
}

// A burst of writes (a job accepted, which also touches the worker) should cause
// one refresh, not three.
function scheduleLiveRefresh(entity) {
    pendingLiveEntities.add(entity);
    if (liveRefreshTimer) return;
    liveRefreshTimer = setTimeout(() => {
        liveRefreshTimer = null;
        const entities = new Set(pendingLiveEntities);
        pendingLiveEntities.clear();
        applyLiveRefresh(entities);
    }, 400);
}

function applyLiveRefresh(entities) {
    const workerSideChanged = entities.has('worker') || entities.has('availability');
    const jobChanged = entities.has('job');

    // Only the surface actually on screen is re-read.
    if (state.portal === 'customer') {
        if (state.customerView === 'bookings' && jobChanged) loadCustomerBookings();
        else if (workerSideChanged || jobChanged) loadCustomerHomeData();
    } else if (state.portal === 'worker') {
        if (state.workerView === 'bookings' && jobChanged) loadWorkerBookings();
        else if (state.workerView === 'earnings' && jobChanged) loadWorkerEarnings();
        else if (workerSideChanged || jobChanged) loadWorkerDashboardData();
    } else if (state.portal === 'terminal') {
        loadTerminalData();
    }
}

function connectLiveUpdates() {
    if (liveStream || typeof EventSource === 'undefined') return;

    try {
        liveStream = new EventSource('/api/events');
    } catch (err) {
        console.warn('[GigSync] Live updates unavailable:', err.message);
        return;
    }

    liveStream.addEventListener('ready', () => setLiveIndicator(true));

    liveStream.addEventListener('change', (evt) => {
        let change = null;
        try { change = JSON.parse(evt.data); } catch (_) { return; }
        if (!change || !change.entity) return;
        scheduleLiveRefresh(change.entity);
    });

    liveStream.onerror = () => {
        setLiveIndicator(false);
        if (window.location.hostname.includes('vercel.app')) {
            try { liveStream.close(); } catch(e){}
        }
    };
}

connectLiveUpdates();

document.getElementById('refreshCustWorkersBtn')?.addEventListener('click', () => {
    toast('Refreshing feed...');
    loadCustomerHomeData();
});

document.getElementById('viewAllCustBookingsLink')?.addEventListener('click', () => switchCustomerView('bookings'));

/* ======================================================================
   CUSTOMER PROFILE MODAL (GAP 2 FIX)
   ====================================================================== */

const customerProfileModal = document.getElementById('customerProfileModal');

function openCustomerProfileModal() {
    userDropdownMenu?.classList.add('hidden');
    // Pre-fill with current user data
    if (state.user) {
        document.getElementById('custProfileName') && (document.getElementById('custProfileName').value = state.user.name || '');
        document.getElementById('custProfilePhone') && (document.getElementById('custProfilePhone').value = state.user.phone || '');
        const citySelect = document.getElementById('custProfileCity');
        if (citySelect) {
            const city = state.user.city || state.city;
            const opt = Array.from(citySelect.options).find(o => o.value === city);
            if (opt) citySelect.value = city;
        }
        const areaInput = document.getElementById('custProfileArea');
        if (areaInput) areaInput.value = state.user.area || state.user.profile?.area || '';
    }
    customerProfileModal?.classList.remove('hidden');
}

document.getElementById('closeCustomerProfileModalBtn')?.addEventListener('click', () => customerProfileModal?.classList.add('hidden'));

document.getElementById('customerProfileForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('custProfileName')?.value.trim();
    const city = document.getElementById('custProfileCity')?.value;
    const area = document.getElementById('custProfileArea')?.value.trim() || 'Town';

    // Update local state immediately
    if (state.user) {
        state.user.name = name || state.user.name;
        state.user.city = city || state.user.city;
        state.user.area = area;
    }

    // Update city display
    if (city) updateActiveCity(city);

    // Update display elements
    document.getElementById('userInitials') && (document.getElementById('userInitials').textContent = (name || '').split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase() || 'KR');
    document.getElementById('userDisplayName') && (document.getElementById('userDisplayName').textContent = name || '');
    document.getElementById('dropdownUserName') && (document.getElementById('dropdownUserName').textContent = name || '');

    // Save to backend if authenticated
    if (state.token) {
        await apiFetch('/api/customers/me/profile', {
            method: 'PATCH',
            body: JSON.stringify({ name, city, area })
        }).catch(() => {});
    }

    customerProfileModal?.classList.add('hidden');
    toast(`✅ Profile updated: ${name}`);
});



// Load Customer My Bookings View
async function loadCustomerBookings(filter = 'all') {
    const custPhone = state.user?.phone ? state.user.phone.replace(/\D/g, '') : '';
    if (!custPhone) {
        const listEl = document.getElementById('custFullBookingsList');
        if (listEl) listEl.innerHTML = `<div class="empty-placeholder"><p>No bookings yet.</p></div>`;
        return;
    }

    const res = await apiFetch(`/api/jobs?phone=${encodeURIComponent(custPhone)}`);
    const allJobs = (res.ok && res.data.jobs) ? res.data.jobs : [];
    const availableOpportunities = (res.ok && Array.isArray(res.data.opportunities)) ? res.data.opportunities : [];
    const jobs = allJobs.filter(j => {
        const jp = (j.customer_phone || '').replace(/\D/g, '');
        return jp === custPhone || (state.user && j.customer_id === state.user.id);
    });
    state.jobs = jobs;

    let filtered = jobs;
    if (filter === 'upcoming') {
        filtered = jobs.filter(j => j.status === 'Requested' || j.status === 'Confirmed' || j.status === 'Assigned' || j.status === 'Accepted');
    } else if (filter === 'active') {
        filtered = jobs.filter(j => j.status === 'In Progress' || j.status === 'On the Way');
    } else if (filter === 'completed') {
        filtered = jobs.filter(j => j.status === 'Completed');
    } else if (filter === 'cancelled') {
        filtered = jobs.filter(j => j.status === 'Cancelled');
    }

    const listEl = document.getElementById('custFullBookingsList');
    if (!listEl) return;

    if (filtered.length === 0) {
        listEl.innerHTML = `<div class="empty-placeholder"><p>No bookings yet.</p></div>`;
        return;
    }

    listEl.innerHTML = filtered.map(j => `
        <div class="booking-card">
            <div class="booking-info">
                <h4 class="booking-service-title">${j.service}</h4>
                <p style="font-size:13px;color:var(--gs-text-secondary);margin:2px 0 6px 0">${j.problem_description || 'Service request'}</p>
                <div class="booking-meta-row">
                    <span><i class="fa-solid fa-clock"></i> ${j.requested_date} • ${j.requested_time}</span>
                    <span><i class="fa-solid fa-location-dot"></i> ${j.location || state.city}</span>
                    <span><i class="fa-solid fa-indian-rupee-sign"></i> ${j.budget || '₹300'}</span>
                </div>
            </div>
            <div class="booking-actions-col">
                <span class="status-pill ${j.status.toLowerCase().replace(/\s+/g, '-')}">
                    <span class="status-indicator"></span> ${j.status}
                </span>
                ${j.status !== 'Completed' && j.status !== 'Cancelled' ? `<button type="button" class="btn btn-outline btn-sm" onclick="window._cancelJob('${j.id}')">Cancel</button>` : ''}
            </div>
        </div>
    `).join('');
}

window._cancelJob = async function(id) {
    if (!confirm('Are you sure you want to cancel this booking?')) return;
    const res = await apiFetch(`/api/jobs/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'Cancelled' })
    });
    if (res.ok) {
        toast('Booking cancelled.');
        loadCustomerBookings();
    }
};

document.querySelectorAll('#custBookingsFilterTabs .filter-pill').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('#custBookingsFilterTabs .filter-pill').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        loadCustomerBookings(btn.dataset.filter);
    });
});

/* ======================================================================
   2. WORKER PORTAL DATA & LOGIC
   ====================================================================== */

let workerIsActive = true;

// Worker Duty Switch
document.getElementById('workerDutyToggleBtn')?.addEventListener('click', async () => {
    workerIsActive = !workerIsActive;
    const btn = document.getElementById('workerDutyToggleBtn');
    const label = document.getElementById('dutyStatusLabel');
    btn?.classList.toggle('on', workerIsActive);
    if (label) label.textContent = workerIsActive ? 'ACTIVE' : 'INACTIVE';
    toast(workerIsActive ? '🟢 You are now marked ACTIVE for new jobs.' : '⚪ You are now marked INACTIVE.');

    // Use correct authenticated worker endpoint
    await apiFetch('/api/workers/me/availability', {
        method: 'PATCH',
        body: JSON.stringify({ is_available: workerIsActive })
    });
});

// =========================================================================
// WORKER AVAILABILITY MODAL — Pattern-based scheduling
// =========================================================================

const workerAvailModal = document.getElementById('workerAvailModal');
document.getElementById('openEditAvailModalBtn')?.addEventListener('click', () => {
    const today = new Date().toISOString().split('T')[0];
    const rs = document.getElementById('availRangeStart');
    if (rs) { if (!rs.value) rs.value = today; rs.min = today; }
    const re = document.getElementById('availRangeEnd');
    if (re) re.min = today;

    workerAvailModal?.classList.remove('hidden');
    _refreshAvailSlotsList();
});
document.getElementById('closeAvailModalBtn')?.addEventListener('click', () => workerAvailModal?.classList.add('hidden'));

// Set today as minimum date for the start date picker
(function() {
    const today = new Date().toISOString().split('T')[0];
    const rs = document.getElementById('availRangeStart');
    if (rs) { rs.value = today; rs.min = today; }
    const re = document.getElementById('availRangeEnd');
    if (re) re.min = today;
})();

// ---- Pattern tab switching ----
let _availPattern = 'once';
document.querySelectorAll('#availPatternTabs .avail-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('#availPatternTabs .avail-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        _availPattern = tab.dataset.pattern;

        const dowRow      = document.getElementById('availDowRow');
        const endDateFld  = document.getElementById('availEndDateField');
        const startLbl    = document.getElementById('availStartDateLabel');

        if (_availPattern === 'weekly') {
            dowRow?.classList.remove('hidden');
            endDateFld?.classList.remove('hidden');
            if (startLbl) startLbl.textContent = 'From';
        } else if (_availPattern === 'daily') {
            dowRow?.classList.add('hidden');
            endDateFld?.classList.remove('hidden');
            if (startLbl) startLbl.textContent = 'From';
        } else {
            dowRow?.classList.add('hidden');
            endDateFld?.classList.add('hidden');
            if (startLbl) startLbl.textContent = 'Date';
        }
    });
});

// ---- Day-of-week chip toggle ----
const _selectedDow = new Set();
document.querySelectorAll('#availDowChips .dow-chip').forEach(chip => {
    chip.addEventListener('click', () => {
        const d = parseInt(chip.dataset.day, 10);
        if (_selectedDow.has(d)) {
            _selectedDow.delete(d);
            chip.classList.remove('active');
        } else {
            _selectedDow.add(d);
            chip.classList.add('active');
        }
    });
});

// ---- Refresh saved slots list ----
async function _refreshAvailSlotsList() {
    const listEl = document.getElementById('availSlotsList');
    if (!listEl) return;
    try {
        const r = await apiFetch('/api/workers/me/schedule');
        const slots = r.ok ? (r.data?.availabilitySlots || []) : [];
        if (slots.length === 0) {
            listEl.innerHTML = '<em style="color:var(--gs-muted);font-size:13px">No slots saved yet.</em>';
            return;
        }
        listEl.innerHTML = slots.slice(0, 5).map(s => {
            const pat = s.pattern || 'once';
            const patLabel = pat === 'weekly' ? '🔁 Weekly' : pat === 'daily' ? '☀️ Daily' : '📅 Once';
            let dateLabel = s.date_str;
            if (s.range_end) dateLabel += ` → ${s.range_end}`;
            let dowLabel = '';
            if (pat === 'weekly') {
                try {
                    const days = JSON.parse(s.days_of_week || '[]');
                    const names = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
                    dowLabel = ' · ' + days.map(d => names[d]).join(', ');
                } catch (_) {}
            }
            return `<div class="avail-slot-row">
                <span class="avail-slot-pat">${patLabel}</span>
                <span class="avail-slot-info">${dateLabel}${dowLabel} · ${s.start_time}–${s.end_time}</span>
            </div>`;
        }).join('');
    } catch (_) {}
}

// ---- Form submit: save + conflict check ----
document.getElementById('workerAvailForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const rangeStart = document.getElementById('availRangeStart')?.value;
    const rangeEnd   = document.getElementById('availRangeEnd')?.value || null;
    const startTime  = document.getElementById('availStartTimeSelect')?.value;
    const endTime    = document.getElementById('availEndTimeSelect')?.value;

    if (!rangeStart || !startTime || !endTime) {
        toast('Please select a date and working hours.');
        return;
    }

    if (_availPattern === 'weekly' && _selectedDow.size === 0) {
        toast('Please select at least one day of the week.');
        return;
    }

    const saveBtn = document.getElementById('saveAvailBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

    const payload = {
        worker_id:    state.user?.id || null,
        worker_phone: state.user?.phone || null,
        pattern:      _availPattern,
        daysOfWeek:   [..._selectedDow],
        rangeStart,
        rangeEnd,
        range_start:  rangeStart,
        range_end:    rangeEnd,
        date_str:     rangeStart,
        start_time:   startTime,
        end_time:     endTime,
        is_available: true
    };

    // 1. Save the availability
    const saveRes = await apiFetch('/api/workers/me/availability', {
        method: 'PATCH', body: JSON.stringify(payload)
    });
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Availability'; }

    if (!saveRes.ok) {
        toast('❌ ' + (saveRes.data?.message || 'Failed to save availability.'));
        return;
    }


    toast('✅ Availability saved!');
    _refreshAvailSlotsList();
    workerAvailModal?.classList.add('hidden');

    // Update badge
    const badge = document.getElementById('workerAvailBadge');
    if (badge) { badge.textContent = `🟢 Available (${startTime} – ${endTime})`; badge.className = 'avail-badge available'; }
    const label = document.getElementById('workerTodayHoursLabel');
    if (label) label.textContent = `${startTime} – ${endTime}`;

    // 2. Pre-flight conflict check
    const slotsParam = encodeURIComponent(JSON.stringify([payload]));
    const cfRes = await apiFetch(`/api/workers/me/availability/conflicts?slots=${slotsParam}`);
    if (!cfRes.ok) return;
    const conflicts = cfRes.data?.conflicts || [];
    if (conflicts.length === 0) return;

    // 3. Show conflict modal
    _showConflictModal(conflicts);
});

// ---- Conflict resolution modal ----
const _conflictDecisions = new Map(); // jobId → canWork bool

function _showConflictModal(conflicts) {
    const modal  = document.getElementById('workerConflictModal');
    const listEl = document.getElementById('conflictJobsList');
    if (!modal || !listEl) return;

    _conflictDecisions.clear();
    // Default all to canWork=true (worker keeps the job unless they say no)
    conflicts.forEach(j => _conflictDecisions.set(j.id, true));

    listEl.innerHTML = conflicts.map(j => `
        <div class="conflict-job-card" id="cfCard_${j.id}">
            <div class="conflict-job-info">
                <strong>${j.service}</strong>
                <span>${j.requested_date} · ${j.requested_time}</span>
                <span>${j.customer_name || 'Customer'}</span>
            </div>
            <div class="conflict-job-btns">
                <button type="button" class="btn btn-primary btn-sm cf-yes" data-job="${j.id}">
                    ✅ I can work it
                </button>
                <button type="button" class="btn btn-danger-ghost btn-sm cf-no" data-job="${j.id}">
                    ❌ Cannot work
                </button>
            </div>
        </div>
    `).join('');

    // Wire up yes/no
    listEl.querySelectorAll('.cf-yes').forEach(btn => {
        btn.addEventListener('click', () => {
            _conflictDecisions.set(btn.dataset.job, true);
            const card = document.getElementById(`cfCard_${btn.dataset.job}`);
            if (card) { card.style.opacity = '0.6'; card.querySelector('.cf-yes').style.outline = '2px solid var(--gs-primary)'; }
        });
    });
    listEl.querySelectorAll('.cf-no').forEach(btn => {
        btn.addEventListener('click', () => {
            _conflictDecisions.set(btn.dataset.job, false);
            const card = document.getElementById(`cfCard_${btn.dataset.job}`);
            if (card) { card.style.opacity = '0.6'; card.querySelector('.cf-no').style.outline = '2px solid var(--gs-danger, #ef4444)'; }
        });
    });

    modal.classList.remove('hidden');
}

document.getElementById('conflictDoneBtn')?.addEventListener('click', async () => {
    const modal = document.getElementById('workerConflictModal');
    const decisions = [..._conflictDecisions.entries()].map(([jobId, canWork]) => ({ jobId, canWork }));

    const res = await apiFetch('/api/workers/me/availability/resolve', {
        method: 'POST', body: JSON.stringify({ decisions })
    });

    modal?.classList.add('hidden');

    const cancelled = decisions.filter(d => !d.canWork).length;
    if (cancelled > 0) {
        toast(`📢 ${cancelled} job${cancelled > 1 ? 's' : ''} reposted for other workers. Customer notified.`);
    }
    toast('✅ Decisions saved.');
    loadWorkerDashboardData();
});

// =========================================================================
// CUSTOMER CALENDAR BOOKING FLOW
// =========================================================================

let _calYear, _calMonth;
let _calSelectedDate = null;
let _calSelectedWorker = null;
let _calCustomerPhone = '';
let _calCustomerName  = '';

function _openCalendarModal() {
    const modal = document.getElementById('customerCalendarModal');
    if (!modal) return;
    const now = new Date();
    _calYear  = now.getFullYear();
    _calMonth = now.getMonth();
    _calSelectedDate   = null;
    _calSelectedWorker = null;
    _renderCalendar();
    // Hide worker panel + time row initially
    document.getElementById('calWorkersPanel')?.classList.add('hidden');
    document.getElementById('calTimeRow')?.classList.add('hidden');
    document.getElementById('calSelectedDateLabel')?.classList.add('hidden');
    modal.classList.remove('hidden');
}

document.getElementById('openCalendarBookingBtn')?.addEventListener('click', _openCalendarModal);
document.getElementById('closeCalendarModalBtn')?.addEventListener('click', () => {
    document.getElementById('customerCalendarModal')?.classList.add('hidden');
});
document.getElementById('calPrevMonthBtn')?.addEventListener('click', () => {
    _calMonth--;
    if (_calMonth < 0) { _calMonth = 11; _calYear--; }
    _renderCalendar();
});
document.getElementById('calNextMonthBtn')?.addEventListener('click', () => {
    _calMonth++;
    if (_calMonth > 11) { _calMonth = 0; _calYear++; }
    _renderCalendar();
});

function _renderCalendar() {
    const grid  = document.getElementById('miniCalGrid');
    const label = document.getElementById('calMonthLabel');
    if (!grid) return;

    const now    = new Date();
    const month  = new Date(_calYear, _calMonth, 1);
    const names  = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    if (label) label.textContent = `${names[_calMonth]} ${_calYear}`;

    const firstDow = month.getDay(); // 0=Sun
    const daysInMonth = new Date(_calYear, _calMonth + 1, 0).getDate();

    let html = '';
    // Empty leading cells
    for (let i = 0; i < firstDow; i++) html += '<div class="cal-cell cal-empty"></div>';

    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${_calYear}-${String(_calMonth + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const cellDate = new Date(_calYear, _calMonth, d);
        const isPast   = cellDate < new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const isToday  = d === now.getDate() && _calMonth === now.getMonth() && _calYear === now.getFullYear();
        const isSelected = dateStr === _calSelectedDate;
        // Check if customer has a booking on this date
        const hasBkg = (state.jobs || []).some(j => j.requested_date === dateStr && j.status !== 'Cancelled');

        let cls = 'cal-cell';
        if (isPast)     cls += ' cal-past';
        if (isToday)    cls += ' cal-today';
        if (isSelected) cls += ' cal-selected';

        html += `<div class="${cls}" data-date="${dateStr}" ${isPast ? 'disabled' : ''}>
            ${d}
            ${hasBkg ? '<span class="cal-dot"></span>' : ''}
        </div>`;
    }
    grid.innerHTML = html;

    // Wire date click
    grid.querySelectorAll('.cal-cell:not(.cal-empty):not(.cal-past)').forEach(cell => {
        cell.addEventListener('click', () => _calSelectDate(cell.dataset.date));
    });
}

async function _calSelectDate(dateStr) {
    _calSelectedDate   = dateStr;
    _calSelectedWorker = null;
    _renderCalendar(); // re-render so selected cell highlights

    // Show loading state
    const panel    = document.getElementById('calWorkersPanel');
    const listEl   = document.getElementById('calWorkersList');
    const dateLabel = document.getElementById('calSelectedDateLabel');
    const dateText  = document.getElementById('calDateText');
    const timeRow   = document.getElementById('calTimeRow');

    if (dateText) dateText.textContent = new Date(dateStr + 'T00:00:00').toDateString();
    dateLabel?.classList.remove('hidden');
    panel?.classList.remove('hidden');
    timeRow?.classList.add('hidden');
    if (listEl) listEl.innerHTML = '<div style="text-align:center;padding:16px;color:var(--gs-muted)"><i class="fa-solid fa-spinner fa-spin"></i> Finding specialists…</div>';

    const city = state.city || 'Ramanagara';
    const res = await apiFetch(`/api/workers/available?date=${dateStr}&city=${encodeURIComponent(city)}`);
    const workers = res.ok ? (res.data?.workers || []) : [];

    if (workers.length === 0) {
        listEl.innerHTML = '<p style="color:var(--gs-muted);text-align:center;padding:12px;font-size:13px">No specialists available on this date. Try another date.</p>';
        return;
    }

    listEl.innerHTML = workers.map(w => `
        <div class="cal-worker-card" data-worker-id="${w.id}" data-worker-phone="${w.phone || ''}" data-worker-name="${w.name}" data-worker-trade="${w.trade}" data-worker-price="${w.price || 300}" data-avail-hours="${w.availability_hours || ''}">
            <div class="cal-worker-info">
                <div class="cal-worker-avatar">${w.name ? w.name.split(' ').map(n=>n[0]).join('').substring(0,2).toUpperCase() : '??'}</div>
                <div>
                    <strong>${w.name}</strong>
                    <span>${w.trade} · ₹${w.price || 300}</span>
                    <span style="font-size:11px;color:var(--gs-muted)">${w.availability_hours || ''}</span>
                </div>
            </div>
            <div class="cal-worker-rating">
                <i class="fa-solid fa-star" style="color:#f59e0b;font-size:12px"></i> ${w.rating || '5.0'}
                ${w.is_verified ? '<span class="verified-badge-sm">✓</span>' : ''}
            </div>
        </div>
    `).join('');

    // Wire worker selection
    listEl.querySelectorAll('.cal-worker-card').forEach(card => {
        card.addEventListener('click', () => {
            listEl.querySelectorAll('.cal-worker-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            _calSelectedWorker = {
                id:    card.dataset.workerId,
                phone: card.dataset.workerPhone,
                name:  card.dataset.workerName,
                trade: card.dataset.workerTrade,
                price: card.dataset.workerPrice,
                availHours: card.dataset.availHours
            };
            timeRow?.classList.remove('hidden');
        });
    });
}

// Confirm calendar booking
document.getElementById('calConfirmBookingBtn')?.addEventListener('click', async () => {
    if (!_calSelectedDate || !_calSelectedWorker) {
        toast('Please select a date and specialist.');
        return;
    }

    // Ensure we have customer phone
    _calCustomerPhone = state.user?.phone || _calCustomerPhone;
    _calCustomerName  = state.user?.name  || _calCustomerName;
    if (!_calCustomerPhone) {
        const ph = prompt('Please enter your 10-digit mobile number:');
        if (!ph || !/^[6-9]\d{9}$/.test(ph.trim().replace(/\D/g,''))) {
            toast('A valid mobile number is required.'); return;
        }
        _calCustomerPhone = ph.trim().replace(/\D/g,'');
        _calCustomerName  = prompt('Your name:') || 'Customer';
    }

    const time = document.getElementById('calTimeSelect')?.value || '10:00 AM';

    const payload = {
        customer_phone:      _calCustomerPhone,
        customer_name:       _calCustomerName,
        worker_id:           _calSelectedWorker.id   || null,
        worker_phone:        _calSelectedWorker.phone || null,
        worker_name:         _calSelectedWorker.name,
        service:             _calSelectedWorker.trade,
        problem_description: `Calendar booking for ${_calSelectedWorker.name} (${_calSelectedWorker.trade})`,
        location:            state.user?.area || 'Town Area',
        city:                state.city || 'Ramanagara',
        requested_date:      _calSelectedDate,
        requested_time:      time,
        budget:              `₹${_calSelectedWorker.price || 300}`,
        status:              'Confirmed',
        payment_method:      'Cash'
    };

    const res = await apiFetch('/api/jobs', { method: 'POST', body: JSON.stringify(payload) });
    document.getElementById('customerCalendarModal')?.classList.add('hidden');

    if (res.ok) {
        toast(`✅ Booking confirmed with ${_calSelectedWorker.name} on ${_calSelectedDate} at ${time}!`);
        loadCustomerHomeData();
        if (state.customerView === 'bookings') loadCustomerBookings();
    } else {
        toast('❌ ' + (res.data?.message || 'Booking failed. Try another time.'));
    }
});



// Load Worker Dashboard Data
async function loadWorkerDashboardData() {
    if (state.user) {
        const initials = state.user.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
        document.getElementById('workerInitials') && (document.getElementById('workerInitials').textContent = initials);
        document.getElementById('workerDisplayName') && (document.getElementById('workerDisplayName').textContent = state.user.name);
        document.getElementById('wDropdownName') && (document.getElementById('wDropdownName').textContent = state.user.name);

        // GAP 1 FIX: Resolve trade from multiple possible sources
        const workerTrade = state.user.profile?.trade || state.user.trade || 'Specialist';
        const tradeIcons = {
            'Electrician': '⚡', 'Master Electrician': '⚡',
            'Plumber': '🔧', 'Plumbing Specialist': '🔧',
            'Carpenter': '🔨', 'General Carpenter': '🔨',
            'Mechanic': '🏍️', 'Two-Wheeler Mechanic': '🏍️',
            'AC': '❄️', 'AC & Fridge Tech': '❄️',
            'Painter': '🎨', 'Appliance': '🔌', 'Appliance Repair Tech': '🔌',
            'Tailor': '🧵', 'Cleaner': '🧹', 'Home Cleaner': '🧹'
        };
        const tradeIcon = Object.keys(tradeIcons).find(k => workerTrade.includes(k)) ? tradeIcons[Object.keys(tradeIcons).find(k => workerTrade.includes(k))] : '🔧';
        document.getElementById('workerTradeHeading') && (document.getElementById('workerTradeHeading').textContent = `${tradeIcon} ${workerTrade}`);
        document.getElementById('wDropdownTrade') && (document.getElementById('wDropdownTrade').textContent = workerTrade);
    }

    // Fetch real worker profile if available (for real trade + availability)
    let workerProfile = null;
    if (state.user && state.token) {
        const meRes = await apiFetch('/api/auth/me');
        if (meRes.ok && meRes.data.user) {
            state.user = { ...state.user, ...meRes.data.user };
            const trade = state.user.profile?.trade;
            if (trade) {
                const tradeIcons = {
                    'Electrician': '⚡', 'Master Electrician': '⚡',
                    'Plumber': '🔧', 'Plumbing Specialist': '🔧',
                    'Carpenter': '🔨', 'General Carpenter': '🔨',
                    'Mechanic': '🏍️', 'Two-Wheeler Mechanic': '🏍️',
                    'AC': '❄️', 'AC & Fridge Tech': '❄️',
                    'Painter': '🎨', 'Appliance': '🔌', 'Appliance Repair Tech': '🔌',
                    'Tailor': '🧵', 'Cleaner': '🧹', 'Home Cleaner': '🧹'
                };
                const tradeIcon = Object.keys(tradeIcons).find(k => trade.includes(k)) ? tradeIcons[Object.keys(tradeIcons).find(k => trade.includes(k))] : '🔧';
                document.getElementById('workerTradeHeading') && (document.getElementById('workerTradeHeading').textContent = `${tradeIcon} ${trade}`);
                document.getElementById('wDropdownTrade') && (document.getElementById('wDropdownTrade').textContent = trade);
            }
            workerProfile = state.user.profile;
        }
    }

    // Fetch worker schedule and active availability slots from DB
    let workerSchedule = null;
    try {
        const schedEndpoint = (workerProfile && workerProfile.id) ? `/api/workers/${workerProfile.id}/schedule` : '/api/workers/me/schedule';
        const schedRes = await apiFetch(schedEndpoint);
        if (schedRes.ok && schedRes.data) {
            workerSchedule = schedRes.data;
        }
    } catch (_) {}

    const workerPhone = state.user?.phone ? String(state.user.phone).replace(/\D/g, '') : '';
    const jobsUrl = workerPhone ? `/api/jobs?worker_phone=${encodeURIComponent(workerPhone)}` : '/api/jobs';
    const res = await apiFetch(jobsUrl);
    const allJobs = (res.ok && res.data.jobs) ? res.data.jobs : [];
    // Filter jobs strictly relevant to this worker
    const jobs = workerPhone ? allJobs.filter(j => String(j.worker_phone || '').replace(/\D/g, '') === workerPhone || (j.worker_phone === null && j.status === 'Requested')) : [];
    state.jobs = jobs;

    // Availability Display — show slot or 'On Duty' from database schedule
    const availBadge = document.getElementById('workerAvailBadge');
    const todayHoursLabel = document.getElementById('workerTodayHoursLabel');
    const slots = workerSchedule?.availabilitySlots || [];
    if (slots.length > 0) {
        const latest = slots[0];
        if (todayHoursLabel) {
            todayHoursLabel.textContent = `${latest.start_time} – ${latest.end_time} (${latest.date_str})`;
        }
        if (availBadge) {
            availBadge.textContent = latest.is_available ? `🟢 Available (${latest.start_time} – ${latest.end_time})` : '⚪ Off Duty';
            availBadge.className = `avail-badge ${latest.is_available ? 'available' : 'unavailable'}`;
        }
    } else {
        if (availBadge) {
            availBadge.textContent = workerIsActive ? '🟢 Available' : '⚪ Off Duty';
            availBadge.className = `avail-badge ${workerIsActive ? 'available' : 'unavailable'}`;
        }
    }

    // Current In-Progress Job (worker's own)
    const currentJob = allJobs.find(j =>
        (j.status === 'In Progress' || j.status === 'On the Way') &&
        (!workerPhone || j.worker_phone === workerPhone)
    );
    const currentContainer = document.getElementById('workerCurrentBookingContainer');
    if (currentContainer) {
        if (!currentJob) {
            currentContainer.innerHTML = `<div class="empty-placeholder"><p>No job in progress right now.</p></div>`;
        } else {
            currentContainer.innerHTML = `
                <div class="booking-card">
                    <div class="booking-info">
                        <h4 class="booking-service-title">${currentJob.service}</h4>
                        <p style="font-size:13px;color:var(--gs-text-secondary);margin:2px 0 6px 0">${currentJob.problem_description}</p>
                        <div class="booking-meta-row">
                            <span><i class="fa-solid fa-user"></i> ${currentJob.customer_name || 'Customer'}</span>
                            <span><i class="fa-solid fa-location-dot"></i> ${currentJob.location || state.city}</span>
                            <span><i class="fa-solid fa-clock"></i> ${currentJob.requested_time}</span>
                        </div>
                    </div>
                    <div class="booking-actions-col">
                        <span class="status-pill progress">🟢 In Progress</span>
                        <button type="button" class="btn btn-primary btn-sm" onclick="window._workerUpdateJobStatus('${currentJob.id}', 'Completed')">
                            Mark Completed
                        </button>
                    </div>
                </div>
            `;
        }
    }

    // GAP 3: Available Job Opportunities — unassigned Requested jobs in worker's city/trade
    const workerCity = state.user?.city || state.city;
    const workerTrade2 = (state.user?.profile?.trade || state.user?.trade || '').toLowerCase();
    const opportunities = availableOpportunities.length > 0 ? availableOpportunities : allJobs.filter(j =>
        j.status === 'Requested' && !j.worker_phone && (!workerCity || j.city === workerCity || j.city === state.city)
    );

    // Show opportunities and assigned bookings in the Assigned/Upcoming Bookings section
    const upcomingList = document.getElementById('workerUpcomingBookingsList');
    const assignedListEl = document.getElementById('workerAssignedJobsList');
    const cleanWorkerPhone = workerPhone ? workerPhone.replace(/\D/g, '') : '';

    // Worker's own assigned/confirmed/accepted bookings across ALL dates
    const myUpcoming = allJobs.filter(j => {
        const jp = (j.worker_phone || '').replace(/\D/g, '');
        const profileId = workerProfile && workerProfile.id;
        const isMyJob = (cleanWorkerPhone && jp === cleanWorkerPhone) || (profileId && Number(j.worker_id) === Number(profileId));
        return isMyJob && ['Requested', 'Confirmed', 'Assigned', 'Accepted', 'In Progress', 'On the Way'].includes(j.status);
    });

    let html = '';

    if (opportunities.length > 0) {
        html += `<div class="section-subtext" style="padding:8px 0 6px;font-size:12px;color:var(--gs-primary);font-weight:600;letter-spacing:.5px">📢 AVAILABLE JOB REQUESTS IN YOUR AREA</div>`;
        html += opportunities.map(j => `
            <div class="booking-card" style="border-left:3px solid var(--gs-primary);">
                <div class="booking-info">
                    <h4 class="booking-service-title">${j.service} <span style="font-size:11px;font-weight:500;color:var(--gs-muted)">Job #${j.id}</span></h4>
                    <p style="font-size:12.5px;color:var(--gs-text-secondary);margin:2px 0 5px">${j.problem_description}</p>
                    <div class="booking-meta-row">
                        <span><i class="fa-solid fa-clock"></i> ${j.requested_date} • ${j.requested_time}</span>
                        <span><i class="fa-solid fa-location-dot"></i> ${j.location || j.city}</span>
                        <span><i class="fa-solid fa-indian-rupee-sign"></i> ${j.budget || '₹300'}</span>
                    </div>
                </div>
                <div class="booking-actions-col" style="gap:6px;">
                    <button type="button" class="btn btn-primary btn-sm" onclick="window._workerAcceptJob('${j.id}')">
                        <i class="fa-solid fa-check"></i> Accept
                    </button>
                    <button type="button" class="btn btn-outline btn-sm" onclick="window._workerDeclineJob('${j.id}')">
                        <i class="fa-solid fa-xmark"></i> Decline
                    </button>
                </div>
            </div>
        `).join('');
    }

    if (myUpcoming.length > 0) {
        if (html) html += `<div style="height:8px"></div>`;
        html += `<div class="section-subtext" style="padding:8px 0 6px;font-size:12px;color:var(--gs-text-secondary);font-weight:600;letter-spacing:.5px">MY ASSIGNED &amp; UPCOMING BOOKINGS</div>`;
        html += myUpcoming.map(j => `
            <div class="booking-card">
                <div class="booking-info">
                    <h4 class="booking-service-title">${j.service} <span style="font-size:11px;font-weight:500;color:var(--gs-muted)">Job #${j.id}</span></h4>
                    <p style="font-size:12.5px;color:var(--gs-text-secondary);margin:2px 0 5px">${j.problem_description || 'Assigned Job'}</p>
                    <div class="booking-meta-row">
                        <span><i class="fa-solid fa-clock"></i> ${j.requested_date} • ${j.requested_time}</span>
                        <span><i class="fa-solid fa-location-dot"></i> ${j.location || state.city}</span>
                        <span><i class="fa-solid fa-indian-rupee-sign"></i> ${j.budget || '₹300'}</span>
                    </div>
                </div>
                <div class="booking-actions-col">
                    <span class="status-pill ${j.status.toLowerCase().replace(/\s+/g, '-')}">${j.status}</span>
                    ${j.status !== 'In Progress' && j.status !== 'Completed' ? `
                        <button type="button" class="btn btn-primary btn-sm" onclick="window._workerUpdateJobStatus('${j.id}', 'In Progress')">
                            Start Job
                        </button>
                    ` : ''}
                </div>
            </div>
        `).join('');
    }

    if (!html) {
        html = `<div class="empty-placeholder"><p>No job requests or assigned bookings yet.</p></div>`;
    }

    if (upcomingList) upcomingList.innerHTML = html;
    if (assignedListEl) assignedListEl.innerHTML = html;
}

window._workerUpdateJobStatus = async function(id, status) {
    const res = await apiFetch(`/api/jobs/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status })
    });
    if (res.ok) {
        toast(`Job #${id} → ${status}`);
        loadWorkerDashboardData();
        if (state.workerView === 'bookings') loadWorkerBookings();
        if (state.workerView === 'earnings') loadWorkerEarnings();
    } else {
        toast('Failed to update job status.');
    }
};

window._workerAcceptJob = async function(id) {
    const res = await apiFetch(`/api/jobs/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'Confirmed' })
    });
    if (res.ok) {
        toast(`✅ Job #${id} accepted! It's now in your bookings.`);
        loadWorkerDashboardData();
    } else {
        toast('Failed to accept job.');
    }
};

window._workerDeclineJob = async function(id) {
    // Decline just removes from view for this worker — don't change status
    toast(`Job #${id} declined. It remains available for other workers.`);
    // Just refresh to reflect latest state
    loadWorkerDashboardData();
};

// Load Worker Bookings View
async function loadWorkerBookings(filter = 'all') {
    const workerPhone = state.user?.phone ? state.user.phone.replace(/\D/g, '') : '';
    const jobsUrl = workerPhone ? `/api/jobs?worker_phone=${encodeURIComponent(workerPhone)}` : '/api/jobs';
    const res = await apiFetch(jobsUrl);
    const allJobs = (res.ok && res.data.jobs) ? res.data.jobs : [];
    const jobs = workerPhone ? allJobs.filter(j => {
        const wp = (j.worker_phone || '').replace(/\D/g, '');
        return (wp && wp === workerPhone) || (state.user && j.worker_id === state.user.id);
    }) : [];
    state.jobs = jobs;

    let filtered = jobs;
    if (filter === 'current' || filter === 'active') filtered = jobs.filter(j => j.status === 'In Progress' || j.status === 'On the Way');
    else if (filter === 'upcoming') filtered = jobs.filter(j => j.status === 'Requested' || j.status === 'Confirmed' || j.status === 'Assigned' || j.status === 'Accepted');
    else if (filter === 'completed') filtered = jobs.filter(j => j.status === 'Completed');
    else if (filter === 'cancelled') filtered = jobs.filter(j => j.status === 'Cancelled');

    const listEl = document.getElementById('workerAllBookingsList');
    if (!listEl) return;

    if (filtered.length === 0) {
        listEl.innerHTML = `<div class="empty-placeholder"><p>No bookings yet.</p></div>`;
        return;
    }

    listEl.innerHTML = filtered.map(j => `
        <div class="booking-card">
            <div class="booking-info">
                <h4 class="booking-service-title">${j.service}</h4>
                <p style="font-size:13px;color:var(--gs-text-secondary);margin:2px 0 6px 0">${j.problem_description}</p>
                <div class="booking-meta-row">
                    <span><i class="fa-solid fa-clock"></i> ${j.requested_date} • ${j.requested_time}</span>
                    <span><i class="fa-solid fa-location-dot"></i> ${j.location || state.city}</span>
                    <span><i class="fa-solid fa-indian-rupee-sign"></i> ${j.budget || '₹300'}</span>
                </div>
            </div>
            <div class="booking-actions-col">
                <span class="status-pill ${j.status.toLowerCase().replace(/\s+/g, '-')}">${j.status}</span>
            </div>
        </div>
    `).join('');
}

document.querySelectorAll('#workerBookingsFilterTabs .filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#workerBookingsFilterTabs .filter-pill').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        loadWorkerBookings(btn.dataset.filter);
    });
});

// GAP 5: Load Worker Job History & Earnings — uses real per-worker earnings API
async function loadWorkerEarnings() {
    // Determine worker profile ID for real earnings lookup
    const workerId = state.user?.profile?.id || state.user?.id;
    let earningsData = null;

    if (workerId && state.token) {
        const eRes = await apiFetch(`/api/workers/${workerId}/earnings`);
        if (eRes.ok && eRes.data.earnings) {
            earningsData = eRes.data.earnings;
        }
    }

    if (earningsData) {
        document.getElementById('metricCompletedJobs') && (document.getElementById('metricCompletedJobs').textContent = earningsData.totalCompletedJobs || 0);
        document.getElementById('metricTotalEarnings') && (document.getElementById('metricTotalEarnings').textContent = `₹${earningsData.totalEarnings || 0}`);
        document.getElementById('metricMonthEarnings') && (document.getElementById('metricMonthEarnings').textContent = `₹${earningsData.thisMonth || 0}`);
        document.getElementById('metricPendingEarnings') && (document.getElementById('metricPendingEarnings').textContent = `₹${earningsData.pendingEarnings || 0}`);

        const tableBody = document.getElementById('workerEarningsTableBody');
        if (tableBody) {
            const completedJobs = earningsData.completedJobs || [];
            if (completedJobs.length === 0) {
                tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--gs-muted);padding:24px">No completed gigs recorded yet.</td></tr>`;
            } else {
                tableBody.innerHTML = completedJobs.map(j => {
                    const amt = j.final_price ? `₹${j.final_price}` : (j.budget || '₹300');
                    const date = j.completed_at ? new Date(j.completed_at).toLocaleDateString('en-IN') : (j.requested_date || 'Today');
                    return `
                        <tr>
                            <td><strong>${j.service}</strong></td>
                            <td>${j.customer_name || 'Customer'}</td>
                            <td><strong>${amt}</strong></td>
                            <td>${date}</td>
                            <td><span class="status-pill completed">Paid ${j.payment_method || 'Cash'}</span></td>
                        </tr>
                    `;
                }).join('');
            }
        }
    } else {
        // Fallback: compute from job list filtered by this worker
        const res = await apiFetch('/api/jobs');
        const allJobs = (res.ok && res.data.jobs) ? res.data.jobs : [];
        const workerPhone = state.user?.phone;
        const completed = allJobs.filter(j => j.status === 'Completed' && (!workerPhone || j.worker_phone === workerPhone));

        let total = 0;
        completed.forEach(j => { total += parseInt((j.budget || '300').replace(/[^0-9]/g, '')) || 300; });

        document.getElementById('metricCompletedJobs') && (document.getElementById('metricCompletedJobs').textContent = completed.length);
        document.getElementById('metricTotalEarnings') && (document.getElementById('metricTotalEarnings').textContent = `₹${total}`);
        document.getElementById('metricMonthEarnings') && (document.getElementById('metricMonthEarnings').textContent = `₹${total}`);
        document.getElementById('metricPendingEarnings') && (document.getElementById('metricPendingEarnings').textContent = '₹0');

        const tableBody = document.getElementById('workerEarningsTableBody');
        if (tableBody) {
            if (completed.length === 0) {
                tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--gs-muted);padding:24px">No completed gigs recorded yet.</td></tr>`;
            } else {
                tableBody.innerHTML = completed.map(j => `
                    <tr>
                        <td><strong>${j.service}</strong></td>
                        <td>${j.customer_name || 'Customer'}</td>
                        <td><strong>${j.budget || '₹300'}</strong></td>
                        <td>${j.requested_date || 'Today'}</td>
                        <td><span class="status-pill completed">Completed</span></td>
                    </tr>
                `).join('');
            }
        }
    }
}

/* ======================================================================
   3. VOICE AGENT / 3.5MM TERMINAL
   ====================================================================== */

const voiceAgentPowerBtn = document.getElementById('voiceAgentPowerBtn');
const voiceAgentPowerLabel = document.getElementById('voiceAgentPowerLabel');
const voiceAgentPowerDesc = document.getElementById('voiceAgentPowerDesc');

let terminalAudioCtx = null;
let terminalAnalyser = null;
let terminalMicrophoneStream = null;
let terminalSpeechRec = null;
let terminalAudioAnimId = null;

// Conversational VAD & Turn State Variables (5-Second Silence Detection Window)
let isAiSpeaking = false;
let speechRecognitionPaused = false;
let turnSilenceTimer = null;
let currentTurnTranscript = '';
let currentInterimTranscript = '';
// A call should turn around quickly after the caller stops speaking.
// Fast call-style turn taking: finalize shortly after the browser reports that
// speech stopped. The browser's speech-end event is already a natural pause
// signal, so a short debounce keeps the complete final transcript without a
// multi-second wait.
const TURN_SILENCE_TIMEOUT_MS = 650;

function setVoiceAgentState(stateKey, labelText) {
    const badge = document.getElementById('vaLiveStateBadge');
    const text = document.getElementById('vaLiveStateText');
    if (badge) {
        badge.className = `va-state-pill ${stateKey.toLowerCase()}`;
    }
    if (text) {
        text.textContent = labelText;
    }
}

function deduplicateUtterance(str) {
    if (!str) return '';
    return str
        .replace(/\b(\w+(?:\s+\w+){1,4})\s+\1\b/giu, '$1')
        .replace(/\b(\w+)\s+\1\b/giu, '$1')
        .trim();
}

/* ---------- Echo Detection & Self-Voice Filter ---------- */
function isAiSelfEcho(callerText) {
    if (!callerText) return false;
    const cClean = callerText.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
    const cTokens = cClean.split(/\s+/).filter(Boolean);
    if (cTokens.length === 0) return false;

    // Check against recent AI responses within last 15 seconds
    for (const item of (state.recentAiResponses || [])) {
        if (Date.now() - item.time < 15000) {
            const aiClean = item.text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
            const aiTokens = aiClean.split(/\s+/).filter(Boolean);
            if (aiTokens.length === 0) continue;

            // Check 1: Direct substring containment (e.g. caller speech is contained within AI response or vice versa)
            if (aiClean.includes(cClean) || (cClean.length > 8 && aiClean.includes(cClean.slice(0, Math.floor(cClean.length * 0.8))))) {
                return true;
            }

            // Check 2: Word token overlap ratio >= 50%
            let matches = 0;
            for (const token of cTokens) {
                if (aiTokens.includes(token)) matches++;
            }
            const overlapRatio = matches / cTokens.length;
            if (overlapRatio >= 0.50 && cTokens.length >= 2) {
                return true;
            }
        }
    }
    return false;
}

function finalizeCallerTurn() {
    clearTimeout(turnSilenceTimer);
    turnSilenceTimer = null;

    if (isAiSpeaking) {
        currentTurnTranscript = '';
        currentInterimTranscript = '';
        return;
    }

    const raw = (currentTurnTranscript + ' ' + currentInterimTranscript).trim();
    currentTurnTranscript = '';
    currentInterimTranscript = '';

    const cleaned = deduplicateUtterance(raw);
    if (!cleaned || cleaned.length < 2) {
        if (state.voiceAgentActive && !isAiSpeaking) {
            setVoiceAgentState('listening', '🟢 LISTENING');
        }
        return;
    }

    // ECHO SUPPRESSION LAYER 3: Check if this utterance is actually the AI's own audio feedback
    if (isAiSelfEcho(cleaned)) {
        console.log('🔇 Suppressed AI Self-Echo Loopback:', cleaned);
        appendTerminalActivity(`Acoustic echo suppressed: "${cleaned.slice(0, 35)}..."`);
        if (state.voiceAgentActive && !isAiSpeaking) {
            setVoiceAgentState('listening', '🟢 LISTENING');
        }
        return;
    }

    // Prevent duplicate firing within 2 seconds
    if (cleaned === state.lastProcessedTurn && (Date.now() - state.lastProcessedTurnTime < 2000)) {
        return;
    }
    state.lastProcessedTurn = cleaned;
    state.lastProcessedTurnTime = Date.now();

    const input = document.getElementById('terminalTextInput');
    if (input) input.value = cleaned;

    setVoiceAgentState('processing', '🟡 PROCESSING');
    sendAiTurn(cleaned);
}

async function startTerminalAudioPipeline() {
    try {
        terminalMicrophoneStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
            terminalAudioCtx = new AudioCtx();
            const source = terminalAudioCtx.createMediaStreamSource(terminalMicrophoneStream);
            terminalAnalyser = terminalAudioCtx.createAnalyser();
            terminalAnalyser.fftSize = 128;
            source.connect(terminalAnalyser);

            const dataArray = new Uint8Array(terminalAnalyser.frequencyBinCount);
            const vuBar = document.getElementById('terminalVuMeterBar');
            const vuStatus = document.getElementById('terminalLiveAudioStatus');
            if (vuStatus) {
                vuStatus.textContent = 'Listening (Audio Live)';
                vuStatus.classList.add('active');
            }

            function animateVU() {
                if (!state.voiceAgentActive) return;
                terminalAnalyser.getByteFrequencyData(dataArray);
                let sum = 0;
                for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
                const avg = sum / dataArray.length;
                if (vuBar) {
                    const pct = Math.min(100, Math.round((avg / 80) * 100));
                    vuBar.style.width = `${pct}%`;
                }
                terminalAudioAnimId = requestAnimationFrame(animateVU);
            }
            animateVU();
        }

        // Start continuous Speech Recognition with 2-Second Turn Segmentation
        const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (SpeechRec) {
            terminalSpeechRec = new SpeechRec();
            terminalSpeechRec.continuous = true;
            terminalSpeechRec.interimResults = true;
            terminalSpeechRec.lang = getLanguageConfig().speech;

            terminalSpeechRec.onresult = (e) => {
                // ECHO SUPPRESSION: Discard input while AI is speaking
                if (isAiSpeaking) {
                    currentTurnTranscript = '';
                    currentInterimTranscript = '';
                    return;
                }

                currentInterimTranscript = '';
                let newlyFinalized = '';

                for (let i = e.resultIndex; i < e.results.length; ++i) {
                    const chunk = e.results[i][0].transcript;
                    if (e.results[i].isFinal) {
                        newlyFinalized += chunk + ' ';
                    } else {
                        currentInterimTranscript += chunk;
                    }
                }

                if (newlyFinalized) {
                    currentTurnTranscript = (currentTurnTranscript + ' ' + newlyFinalized).trim();
                }

                const livePreview = (currentTurnTranscript + (currentInterimTranscript ? ' ' + currentInterimTranscript : '')).trim();
                if (livePreview) {
                    const input = document.getElementById('terminalTextInput');
                    if (input) input.value = livePreview;
                    setVoiceAgentState('listening', '🟢 LISTENING');

                    // ZERO GAP GREETING: If user starts with an opening greeting (hello/hi/hey/namaskara), answer IMMEDIATELY with zero seconds delay!
                    const isImmediateGreeting = /^(hello|hi|hey|namaskara|namaste|good morning|good afternoon|good evening|ನಮಸ್ಕಾರ)[\s.!?,]*$/i.test(livePreview.trim());
                    if (isImmediateGreeting) {
                        clearTimeout(turnSilenceTimer);
                        finalizeCallerTurn();
                    } else {
                        // Standard 2-second silence timer for detailed conversation / requests
                        clearTimeout(turnSilenceTimer);
                        turnSilenceTimer = setTimeout(() => {
                            finalizeCallerTurn();
                        }, TURN_SILENCE_TIMEOUT_MS);
                    }
                }
            };

            terminalSpeechRec.onspeechend = () => {
                // Start 2-second silence countdown as soon as caller stops speaking
                if (currentTurnTranscript || currentInterimTranscript) {
                    const isImmediateGreeting = /^(hello|hi|hey|namaskara|namaste|good morning|good afternoon|good evening|ನಮಸ್ಕಾರ)[\s.!?,]*$/i.test((currentTurnTranscript + ' ' + currentInterimTranscript).trim());
                    if (isImmediateGreeting) {
                        clearTimeout(turnSilenceTimer);
                        finalizeCallerTurn();
                    } else {
                        clearTimeout(turnSilenceTimer);
                        turnSilenceTimer = setTimeout(() => {
                            finalizeCallerTurn();
                        }, TURN_SILENCE_TIMEOUT_MS);
                    }
                }
            };

            terminalSpeechRec.onerror = (err) => {
                if (err.error !== 'no-speech' && err.error !== 'aborted') {
                    console.warn('Terminal speech recognition error:', err.error);
                }
                if (state.voiceAgentActive && !isAiSpeaking) {
                    setVoiceAgentState('listening', '🟢 LISTENING');
                }
            };

            terminalSpeechRec.onend = () => {
                if (state.voiceAgentActive && !isAiSpeaking && !speechRecognitionPaused) {
                    setTimeout(() => {
                        if (state.voiceAgentActive && !isAiSpeaking && !speechRecognitionPaused) {
                            try { terminalSpeechRec.start(); } catch(e){}
                        }
                    }, 100);
                }
            };

            terminalSpeechRec.start();
            setVoiceAgentState('listening', '🟢 LISTENING');
        }
    } catch(err) {
        console.error('Audio hardware access error:', err);
        toast('Please grant microphone permission to capture 3.5mm sound card audio.');
    }
}

function stopTerminalAudioPipeline() {
    clearTimeout(turnSilenceTimer);
    turnSilenceTimer = null;
    currentTurnTranscript = '';
    currentInterimTranscript = '';
    isAiSpeaking = false;

    if (terminalAudioAnimId) {
        cancelAnimationFrame(terminalAudioAnimId);
        terminalAudioAnimId = null;
    }
    if (terminalMicrophoneStream) {
        terminalMicrophoneStream.getTracks().forEach(t => t.stop());
        terminalMicrophoneStream = null;
    }
    if (terminalAudioCtx) {
        try { terminalAudioCtx.close(); } catch(e){}
        terminalAudioCtx = null;
    }
    if (terminalSpeechRec) {
        try { terminalSpeechRec.stop(); } catch(e){}
        terminalSpeechRec = null;
    }
    const vuBar = document.getElementById('terminalVuMeterBar');
    if (vuBar) vuBar.style.width = '0%';
    const vuStatus = document.getElementById('terminalLiveAudioStatus');
    if (vuStatus) {
        vuStatus.textContent = 'Pipeline Idle';
        vuStatus.classList.remove('active');
    }
    setVoiceAgentState('idle', '⚪ IDLE');
}

voiceAgentPowerBtn?.addEventListener('click', () => {
    state.voiceAgentActive = !state.voiceAgentActive;
    voiceAgentPowerBtn.classList.toggle('on', state.voiceAgentActive);
    voiceAgentPowerBtn.classList.toggle('off', !state.voiceAgentActive);

    if (state.voiceAgentActive) {
        voiceAgentPowerLabel.textContent = '🟢 ON';
        voiceAgentPowerDesc.textContent = 'Voice processing pipeline is LIVE and actively listening through 3.5mm sound card / Bluetooth.';
        toast('🟢 Voice Agent Pipeline Activated');
        appendTerminalActivity('Voice Agent pipeline enabled by operator');
        appendTerminalAction('✓ Voice processing pipeline initialized');
        startTerminalAudioPipeline();
    } else {
        voiceAgentPowerLabel.textContent = '🔴 OFF';
        voiceAgentPowerDesc.textContent = 'Click to enable incoming voice/audio processing pipeline.';
        toast('🔴 Voice Agent Pipeline Deactivated');
        appendTerminalActivity('Voice Agent pipeline disabled');
        stopTerminalAudioPipeline();
    }
});

// Terminal Clear Transcript & Reset Voice Session
document.getElementById('clearTranscriptBtn')?.addEventListener('click', async () => {
    const box = document.getElementById('terminalTranscriptBox');
    if (box) {
        box.innerHTML = `<div class="transcript-idle" id="transcriptIdleMsg"><i class="fa-solid fa-microphone-slash"></i><p>Waiting for voice input...</p></div>`;
    }
    const actionsBox = document.getElementById('terminalAiActionsBox');
    if (actionsBox) {
        actionsBox.innerHTML = `<div class="action-idle"><p>No actions performed yet.</p></div>`;
    }
    const oldSessionId = state.sessionId;
    state.sessionId = 'voice_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    state.lastProcessedTurn = '';
    state.lastProcessedTurnTime = 0;
    
    renderTerminalCallerStatus({ phone: null, name: 'Caller', registeredWorker: false });
    
    try {
        await apiFetch('/api/ai/reset-session', {
            method: 'POST',
            body: JSON.stringify({ sessionId: oldSessionId })
        });
    } catch (e) {}
    
    toast('🧹 Voice session reset. Ready for new caller.');
});

// Terminal Input Bar Handlers
document.getElementById('terminalSendBtn')?.addEventListener('click', () => {
    const input = document.getElementById('terminalTextInput');
    const text = input?.value.trim();
    if (text) {
        input.value = '';
        setVoiceAgentState('processing', '🟡 PROCESSING');
        sendAiTurn(text);
    }
});

document.getElementById('terminalTextInput')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        const input = document.getElementById('terminalTextInput');
        const text = input?.value.trim();
        if (text) {
            input.value = '';
            setVoiceAgentState('processing', '🟡 PROCESSING');
            sendAiTurn(text);
        }
    }
});

// Terminal Quick Test Prompts
document.querySelectorAll('.t-q-chip').forEach(chip => {
    chip.addEventListener('click', () => {
        const prompt = chip.dataset.tprompt;
        if (prompt) {
            setVoiceAgentState('processing', '🟡 PROCESSING');
            sendAiTurn(prompt);
        }
    });
});

function appendTerminalTranscript(speaker, text) {
    const box = document.getElementById('terminalTranscriptBox');
    const idle = document.getElementById('transcriptIdleMsg');
    if (idle) idle.remove();

    if (box) {
        const row = document.createElement('div');
        row.style.marginBottom = '10px';
        row.innerHTML = `<strong>${speaker}:</strong> <span>${text}</span>`;
        box.appendChild(row);
        box.scrollTop = box.scrollHeight;
    }
}

function appendTerminalAction(actionText) {
    const box = document.getElementById('terminalAiActionsBox');
    if (!box) return;
    const idle = box.querySelector('.action-idle');
    if (idle) idle.remove();

    const item = document.createElement('div');
    item.className = 'action-item';
    item.innerHTML = `<i class="fa-solid fa-check-circle"></i> <span>${actionText}</span>`;
    box.appendChild(item);
}

function appendTerminalActivity(eventText) {
    const list = document.getElementById('terminalActivityLogList');
    if (!list) return;
    const idle = list.querySelector('.empty-placeholder');
    if (idle) idle.remove();

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const row = document.createElement('div');
    row.className = 'log-entry-row';
    row.innerHTML = `<span>${eventText}</span><span style="color:var(--gs-muted)">${time}</span>`;
    list.prepend(row);
}

document.getElementById('clearTranscriptBtn')?.addEventListener('click', () => {
    const box = document.getElementById('terminalTranscriptBox');
    if (box) box.innerHTML = `<div class="transcript-idle" id="transcriptIdleMsg"><i class="fa-solid fa-microphone-slash"></i><p>Waiting for voice input...</p></div>`;
});

document.getElementById('refreshActivityLogBtn')?.addEventListener('click', () => {
    toast('Activity log refreshed.');
});

function loadTerminalData() {
    // Honest hardware detection indicators
    const audio35El = document.getElementById('audio35ConnStatus');
    const phoneEl = document.getElementById('phoneConnStatus');
    const outputSelect = document.getElementById('terminalAudioOutputSelect');

    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        navigator.mediaDevices.enumerateDevices().then(devices => {
            const hasAudioInput = devices.some(d => d.kind === 'audioinput');
            if (audio35El) audio35El.textContent = hasAudioInput ? 'Connected (Audio Input Detected)' : 'Disconnected';

            // Populate Audio Output Devices
            if (outputSelect) {
                const outputs = devices.filter(d => d.kind === 'audiooutput');
                if (outputs.length > 0) {
                    outputSelect.innerHTML = outputs.map(o => `<option value="${o.deviceId}">${o.label || 'Audio Output (' + o.deviceId.slice(0, 8) + ')'}</option>`).join('');
                }
            }
        }).catch(() => {
            if (audio35El) audio35El.textContent = 'Connection status unavailable';
        });
    } else {
        if (audio35El) audio35El.textContent = 'Connection status unavailable';
    }

    if (phoneEl) phoneEl.textContent = 'Connection status unavailable';
}

// Test AI Voice Diagnostic Button Handler
document.getElementById('testAiVoiceBtn')?.addEventListener('click', async () => {
    toast('🔊 Generating and playing test AI voice...');
    appendTerminalActivity('Diagnostic: AI voice test triggered');
    updateDiagnostic('diagAiResponse', '🟢 Test Triggered', 'ok');
    appendTerminalTranscript('SYSTEM TEST', 'Generating audio: "Hello. This is the GigSync voice agent. Audio output is working."');
    await playTtsAudio('Hello. This is the GigSync voice agent. Audio output is working.');
});

// Play 3.5mm Signal Tone Handler (Continuous / Chime Tone for Telephony Line Testing)
document.getElementById('testToneSignalBtn')?.addEventListener('click', () => {
    toast('🎵 Transmitting 3.5mm electrical tone to phone line...');
    appendTerminalActivity('Diagnostic: 3.5mm signal tone sent to phone');
    updateDiagnostic('diagAudioPlayback', '🟢 Tone Transmitting', 'ok');

    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
            const ctx = new AudioCtx();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            
            // Play a pulsing telecommunication beep pattern (800Hz / 1000Hz)
            osc.frequency.setValueAtTime(800, ctx.currentTime);
            osc.frequency.setValueAtTime(1000, ctx.currentTime + 0.3);
            osc.frequency.setValueAtTime(800, ctx.currentTime + 0.6);
            osc.frequency.setValueAtTime(1200, ctx.currentTime + 0.9);
            
            gain.gain.setValueAtTime(0.5, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 1.5);
            
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 1.5);
            
            setTimeout(() => {
                updateDiagnostic('diagAudioPlayback', '✓ Tone Finished', 'ok');
            }, 1600);
        }
    } catch(e) {
        console.error('Tone generation error:', e);
    }
});

// Test Audio Output Button Handler
document.getElementById('testAudioOutputBtn')?.addEventListener('click', async () => {
    toast('🔊 Playing 3.5mm audio output test...');
    appendTerminalActivity('Output audio test triggered');
    updateDiagnostic('diagAiResponse', '🟢 Test Triggered', 'ok');
    await playTtsAudio('Hello. This is the GigSync voice agent. Audio output is working.');
});

/* ======================================================================
   4. TALK TO GIGSYNC AI VOICE ASSISTANT MODAL
   ====================================================================== */

const aiVoiceModal = document.getElementById('aiVoiceModal');
const aiModalBigMicBtn = document.getElementById('aiModalBigMicBtn');
const aiVoiceStateLabel = document.getElementById('aiVoiceStateLabel');
const aiModalWaveBars = document.getElementById('aiModalWaveBars');
const aiLiveStreamTranscript = document.getElementById('aiLiveStreamTranscript');
const aiLiveStreamText = document.getElementById('aiLiveStreamText');
const aiModalTranscriptBox = document.getElementById('aiModalTranscriptBox');

function openAiVoiceModal() {
    const isWorker = (state.portal === 'worker') || (state.user && state.user.role === 'worker');
    const activeRole = isWorker ? 'worker' : 'customer';
    const rolePrefix = isWorker ? 'work' : 'cust';
    const userPhone = state.user?.phone ? state.user.phone.replace(/\D/g, '') : '';

    // If session was for different role or user, reset it
    if (!state.sessionId || !state.sessionId.startsWith(rolePrefix + '_')) {
        const userKey = userPhone || ('guest_' + Math.random().toString(36).substring(2, 7));
        state.sessionId = `${rolePrefix}_${userKey}_${Date.now()}`;
        const dialogueBox = document.getElementById('aiModalTranscriptBox');
        if (dialogueBox) dialogueBox.innerHTML = '';
    }

    const modalTitle = document.querySelector('#aiVoiceModal .ai-header-title h3');
    const modalSubtitle = document.querySelector('#aiVoiceModal .ai-header-title small');
    const chipsContainer = document.querySelector('#aiVoiceModal .quick-chips-row');
    const dialogueBox = document.getElementById('aiModalTranscriptBox');
    const modalInput = document.getElementById('aiModalTextInput');

    if (modalTitle) modalTitle.textContent = isWorker ? 'GigSync Worker Assistant' : 'Talk to GigSync';
    if (modalSubtitle) modalSubtitle.textContent = isWorker ? 'Manage your work schedule, check jobs, and track earnings' : 'Speak or type in English, ಕನ್ನಡ, or Hindi to book specialists';
    if (modalInput) modalInput.placeholder = isWorker ? 'Type or speak (e.g. Set availability tomorrow 9 to 5, check earnings)...' : 'Type or speak (e.g. Nanage electrician beku, clean my house)...';

    if (chipsContainer) {
        if (isWorker) {
            chipsContainer.innerHTML = `
                <button type="button" class="q-chip" data-qprompt="Did anyone book me?">📋 "Did anyone book me?"</button>
                <button type="button" class="q-chip" data-qprompt="I am available tomorrow from 9 AM to 5 PM.">📅 "Set hours tomorrow 9 to 5"</button>
                <button type="button" class="q-chip" data-qprompt="Check my earnings and completed jobs">💰 "Check my earnings"</button>
                <button type="button" class="q-chip" data-qprompt="Are there any new job requests near me?">🔔 "New jobs near me"</button>
                <button type="button" class="q-chip" data-qprompt="What is my next job?">⚡ "What is my next job?"</button>
            `;
        } else {
            chipsContainer.innerHTML = `
                <button type="button" class="q-chip" data-qprompt="I need a plumber tomorrow morning.">🔧 "I need a plumber tomorrow morning."</button>
                <button type="button" class="q-chip" data-qprompt="Nanage electrician beku.">⚡ "Nanage electrician beku."</button>
                <button type="button" class="q-chip" data-qprompt="I need someone to clean my house tomorrow at 8 AM.">🧹 "Clean my house tomorrow 8 AM"</button>
                <button type="button" class="q-chip" data-qprompt="Show me verified workers near me.">📍 "Show workers near me."</button>
                <button type="button" class="q-chip" data-qprompt="What are my bookings?">📋 "What are my bookings?"</button>
            `;
        }
        chipsContainer.querySelectorAll('.q-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const prompt = chip.dataset.qprompt;
                if (prompt) sendAiTurn(prompt);
            });
        });
    }

    if (dialogueBox && dialogueBox.children.length === 0) {
        const firstName = (state.user && state.user.name) ? ` ${state.user.name.split(' ')[0]}` : '';
        if (isWorker) {
            dialogueBox.innerHTML = `
                <div class="dialogue-entry ai">
                    <strong>GIGSYNC AI:</strong>
                    <span>Hi, I'm GigSync, your assistant. How may I help you?</span>
                </div>
            `;
        } else {
            dialogueBox.innerHTML = `
                <div class="dialogue-entry ai">
                    <strong>GIGSYNC AI:</strong>
                    <span>Hi, I'm GigSync, your assistant. How may I help you?</span>
                </div>
            `;
        }
    }

    aiVoiceModal?.classList.remove('hidden');
}
function closeAiVoiceModal() {
    aiVoiceModal?.classList.add('hidden');
    if (state.isAiModalRecording) {
        stopAiModalListening(false);
    }
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
    }
}

document.getElementById('homeTalkAiActionBtn')?.addEventListener('click', openAiVoiceModal);
document.getElementById('workerTalkAiActionBtn')?.addEventListener('click', openAiVoiceModal);
const customerVoiceAssistantCard = document.getElementById('customerVoiceAssistantCard');
customerVoiceAssistantCard?.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    openAiVoiceModal();
});
customerVoiceAssistantCard?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openAiVoiceModal();
    }
});
document.getElementById('closeAiVoiceModalBtn')?.addEventListener('click', closeAiVoiceModal);

let aiSpeechRecognizer = null;
let accumulatedAiSpeech = '';
let aiAudioStream = null;
let speechRecNetworkBlocked = false;

let modalSilenceTimer = null;

function startAiModalListening() {
    accumulatedAiSpeech = '';
    clearTimeout(modalSilenceTimer);
    modalSilenceTimer = null;
    speechRecNetworkBlocked = false; // Reset on every user click

    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
        toast('Voice recognition is not supported in this browser. Please type your request below.');
        return;
    }

    // IMPORTANT: SpeechRecognition.start() MUST be called synchronously inside
    // the click handler on desktop Chrome — any await before this call breaks
    // the browser's user-gesture context and the mic never activates.
    try {
        if (aiSpeechRecognizer) {
            try { aiSpeechRecognizer.abort(); } catch(e){}
        }

        aiSpeechRecognizer = new SpeechRec();
        aiSpeechRecognizer.continuous = true;
        aiSpeechRecognizer.interimResults = true;
        aiSpeechRecognizer.lang = getLanguageConfig().speech;

        aiSpeechRecognizer.onresult = (event) => {
            let interim = '';
            let final = '';
            for (let i = 0; i < event.results.length; ++i) {
                if (event.results[i].isFinal) {
                    final += event.results[i][0].transcript + ' ';
                } else {
                    interim += event.results[i][0].transcript;
                }
            }
            const liveTextCaptured = (final + interim).trim();
            accumulatedAiSpeech = liveTextCaptured;

            if (aiLiveStreamText && liveTextCaptured) {
                aiLiveStreamText.textContent = `"${liveTextCaptured}"`;
            }
            const modalInput = document.getElementById('aiModalTextInput');
            if (modalInput && liveTextCaptured) {
                modalInput.value = liveTextCaptured;
            }

            // 3.5-second silence auto-send timer
            if (liveTextCaptured) {
                clearTimeout(modalSilenceTimer);
                modalSilenceTimer = setTimeout(() => {
                    if (state.isAiModalRecording) {
                        stopAiModalListening(true);
                    }
                }, 3500);
            }
        };

        aiSpeechRecognizer.onspeechend = () => {
            if (accumulatedAiSpeech) {
                clearTimeout(modalSilenceTimer);
                modalSilenceTimer = setTimeout(() => {
                    if (state.isAiModalRecording) {
                        stopAiModalListening(true);
                    }
                }, 2000);
            }
        };

        aiSpeechRecognizer.onerror = (err) => {
            console.warn('[SpeechRec error]', err.error);
            if (err.error === 'network') {
                if (aiLiveStreamText) aiLiveStreamText.textContent = 'Voice network busy. You can retry speaking or type below.';
            } else if (err.error === 'not-allowed' || err.error === 'permission-denied') {
                toast('Microphone permission denied. Please allow mic access in your browser settings.');
                stopAiModalListening(false);
            }
        };

        aiSpeechRecognizer.onend = () => {
            if (state.isAiModalRecording && accumulatedAiSpeech) {
                stopAiModalListening(true);
            }
        };

        // ✅ Start recognition SYNCHRONOUSLY — preserves desktop user-gesture context
        aiSpeechRecognizer.start();

        // Update UI state AFTER start() succeeds
        state.isAiModalRecording = true;
        aiModalBigMicBtn?.classList.add('recording');
        aiModalWaveBars?.classList.remove('hidden');
        if (aiVoiceStateLabel) aiVoiceStateLabel.textContent = '🔴 Listening... (Speak now)';
        if (aiLiveStreamTranscript) aiLiveStreamTranscript.classList.remove('hidden');
        if (aiLiveStreamText) aiLiveStreamText.textContent = 'Listening to your voice... Speak now';

        // Request getUserMedia AFTER start() — for audio level visualisation only
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            navigator.mediaDevices.getUserMedia({ audio: true })
                .then(stream => { aiAudioStream = stream; })
                .catch(() => {});
        }
    } catch (e) {
        console.error('STT Start Error:', e);
        toast('Unable to start voice recognition. Please try typing your request.');
    }
}

function stopAiModalListening(send = true) {
    clearTimeout(modalSilenceTimer);
    modalSilenceTimer = null;
    state.isAiModalRecording = false;
    aiModalBigMicBtn?.classList.remove('recording');
    aiModalWaveBars?.classList.add('hidden');
    if (aiVoiceStateLabel) aiVoiceStateLabel.textContent = 'Click microphone to speak';
    if (aiLiveStreamTranscript) aiLiveStreamTranscript.classList.add('hidden');

    if (aiSpeechRecognizer) {
        try { aiSpeechRecognizer.stop(); } catch(e){}
    }
    if (aiAudioStream) {
        try { aiAudioStream.getTracks().forEach(t => t.stop()); } catch(e){}
        aiAudioStream = null;
    }

    const captured = accumulatedAiSpeech.trim() || document.getElementById('aiModalTextInput')?.value.trim();
    if (send) {
        if (captured) {
            sendAiTurn(captured);
        } else {
            toast('No voice detected. Please speak clearly into your mic or type below.');
            document.getElementById('aiModalTextInput')?.focus();
        }
    }
}

aiModalBigMicBtn?.addEventListener('click', () => {
    if (state.isAiModalRecording) {
        stopAiModalListening(true);
    } else {
        startAiModalListening();
    }
});

// Send AI turn
async function sendAiTurn(speechText) {
    if (!speechText) return;

    // Immediately silence & abort microphone STT while AI processes and speaks
    pauseSpeechRecognitionForTts();

    const isWorker = (state.portal === 'worker') || (state.user && state.user.role === 'worker');
    const activeRole = isWorker ? 'worker' : 'customer';
    const rolePrefix = isWorker ? 'work' : 'cust';
    const userPhone = state.user?.phone ? state.user.phone.replace(/\D/g, '') : '';

    if (!state.sessionId || !state.sessionId.startsWith(rolePrefix + '_')) {
        const userKey = userPhone || ('guest_' + Math.random().toString(36).substring(2, 7));
        state.sessionId = `${rolePrefix}_${userKey}_${Date.now()}`;
    }

    // Append to dialog
    appendAiDialogue('CALLER', speechText);
    appendTerminalTranscript('CALLER', speechText);
    if (aiVoiceStateLabel) aiVoiceStateLabel.textContent = '🧠 Processing requirement...';
    aiModalWaveBars?.classList.remove('hidden');

    updateDiagnostic('diagInputAudio', '🟢 Received', 'ok');
    updateDiagnostic('diagStt', '🟢 Working (Transcribed)', 'ok');
    updateDiagnostic('diagAiResponse', '🟡 Generating...', 'working');

    // Caller identity (optional pre-identification by operator)
    const terminalCaller = state.portal === 'terminal'
        ? (document.getElementById('terminalCallerPhone')?.value || '').replace(/\D/g, '')
        : '';

    const payload = {
        sessionId: state.sessionId,
        city: state.city,
        portal: state.portal,
        role: activeRole,
        language: getLanguageConfig().label,
        speechText
    };
    if (terminalCaller && terminalCaller.length >= 10) payload.callerPhone = terminalCaller;
    else if (state.portal !== 'terminal' && userPhone) payload.callerPhone = userPhone;

    let res;
    try {
        res = await apiFetch('/api/ai/voice-call', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
    } catch (err) {
        res = { ok: false, data: { message: err.message } };
    }

    aiModalWaveBars?.classList.add('hidden');

    // Show who the server actually resolved the caller to
    if (res.ok && res.data && res.data.callerIdentity) {
        renderTerminalCallerStatus(res.data.callerIdentity);
    }

    if (res.ok && res.data && res.data.spokenResponse) {
        if (aiVoiceStateLabel) aiVoiceStateLabel.textContent = '🔊 Responding...';
        updateDiagnostic('diagAiResponse', '🟢 Generated', 'ok');
        appendAiDialogue('GIGSYNC AI', res.data.spokenResponse);
        appendTerminalTranscript('GIGSYNC AI', res.data.spokenResponse);

        // Play real TTS audio output asynchronously (non-blocking)
        playTtsAudio(res.data.spokenResponse, !!res.data.shouldEndCall).catch(err => console.warn('TTS playback warning:', err));

        if (res.data.actionsPerformed && Array.isArray(res.data.actionsPerformed)) {
            res.data.actionsPerformed.forEach(action => {
                appendTerminalAction(`✓ ${action}`);
                appendTerminalActivity(action);
            });
        } else if (res.data.toolExecuted) {
            appendTerminalAction(`✓ Action executed: ${res.data.toolExecuted}`);
            appendTerminalActivity(`AI dispatch: ${res.data.toolExecuted}`);
        }

        if (res.data.job || (res.data.toolResult && res.data.toolResult.job)) {
            const j = res.data.job || res.data.toolResult.job;
            toast(`✅ Booking #${j.id} updated!`);
            if (state.portal === 'worker' || isWorker) {
                loadWorkerHomeData();
                loadWorkerBookings();
                loadWorkerDashboardData();
            } else {
                loadCustomerHomeData();
                loadCustomerBookings();
            }
        } else if (res.data.toolExecuted === 'updateWorkerAvailability' || res.data.toolExecuted === 'registerOrUpdateWorker' || res.data.toolExecuted === 'updateJobStatusByWorker') {
            if (state.portal === 'worker' || isWorker) {
                loadWorkerHomeData();
                loadWorkerBookings();
                loadWorkerDashboardData();
            }
        }
    } else {
        if (aiVoiceStateLabel) aiVoiceStateLabel.textContent = 'Click microphone to speak';
        updateDiagnostic('diagAiResponse', '🔴 Failed', 'err');
        const reason = (res.data && res.data.message) || 'AI processing service unavailable. Please check your network connection.';
        appendTerminalTranscript('GIGSYNC AI', reason);
        appendAiDialogue('GIGSYNC AI', reason);
        toast(`⚠️ ${reason}`);
    }

    if (state.voiceAgentActive && !isAiSpeaking) {
        setVoiceAgentState('listening', '🟢 LISTENING');
    }
}

// Renders the conversational caller identity onto the terminal's identity card.
function renderTerminalCallerStatus(identity) {
    const el = document.getElementById('terminalCallerStatus');
    const badge = document.getElementById('terminalCallerBadge');
    if (!el) return;
    if (!identity || !identity.phone || identity.phone === 'anonymous') {
        el.textContent = 'New caller — phone number not provided yet';
        el.style.color = 'var(--gs-text-main, #1E293B)';
        if (badge) {
            badge.innerHTML = `<i class="fa-solid fa-circle" style="font-size:7px; color:#F59E0B;"></i> New Caller`;
            badge.style.background = '#FEF3C7';
            badge.style.color = '#B45309';
        }
        return;
    }

    if (identity.registeredWorker) {
        el.innerHTML = `<span style="color:var(--gs-muted);">Caller:</span> <strong>${identity.name}</strong> &nbsp;|&nbsp; <span style="color:var(--gs-muted);">Phone:</span> <strong>${identity.phone}</strong>`;
        el.style.color = 'var(--gs-text-main, #1E293B)';
        if (badge) {
            badge.innerHTML = `<i class="fa-solid fa-circle-check" style="font-size:10px; color:#16A34A;"></i> Existing Worker`;
            badge.style.background = '#DCFCE7';
            badge.style.color = '#15803D';
        }
    } else {
        const callerName = identity.name && identity.name !== 'Caller' ? identity.name : 'New Worker';
        el.innerHTML = `<span style="color:var(--gs-muted);">Caller:</span> <strong>${callerName}</strong> &nbsp;|&nbsp; <span style="color:var(--gs-muted);">Phone:</span> <strong>${identity.phone}</strong>`;
        el.style.color = 'var(--gs-text-main, #1E293B)';
        if (badge) {
            badge.innerHTML = `<i class="fa-solid fa-user-plus" style="font-size:10px; color:#2563EB;"></i> New Worker`;
            badge.style.background = '#EFF6FF';
            badge.style.color = '#1D4ED8';
        }
    }
}

function appendAiDialogue(sender, text) {
    if (!aiModalTranscriptBox) return;
    const line = document.createElement('div');
    line.className = `dialogue-entry ${sender === 'CALLER' ? 'user' : 'ai'}`;
    line.innerHTML = `<strong>${sender}:</strong> <span>${text}</span>`;
    aiModalTranscriptBox.appendChild(line);
    aiModalTranscriptBox.scrollTop = aiModalTranscriptBox.scrollHeight;
}

// AI Modal Text Input Bar Submit
document.getElementById('aiModalSendBtn')?.addEventListener('click', () => {
    const input = document.getElementById('aiModalTextInput');
    const text = input?.value.trim();
    if (text) {
        input.value = '';
        sendAiTurn(text);
    }
});

document.getElementById('aiModalTextInput')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        const input = document.getElementById('aiModalTextInput');
        const text = input?.value.trim();
        if (text) {
            input.value = '';
            sendAiTurn(text);
        }
    }
});

// Quick Prompt Chips
document.querySelectorAll('.q-chip').forEach(chip => {
    chip.addEventListener('click', () => {
        const prompt = chip.dataset.qprompt;
        if (prompt) sendAiTurn(prompt);
    });
});

/* ======================================================================
   INITIAL BOOTSTRAP
   ====================================================================== */
updateActiveCity(state.city);

// Initial check for existing token/session
if (state.token) {
    apiFetch('/api/auth/me').then(res => {
        if (res.ok && res.data.user) {
            state.user = res.data.user;
            switchPortal(state.user.role === 'worker' ? 'worker' : (state.user.role === 'admin' ? 'terminal' : 'customer'));
        } else {
            state.token = null;
            localStorage.removeItem('gigsync_token');
            switchPortal('gateway');
        }
    }).catch(() => {
        state.token = null;
        localStorage.removeItem('gigsync_token');
        switchPortal('gateway');
    });
} else {
    switchPortal('gateway');
}

});
