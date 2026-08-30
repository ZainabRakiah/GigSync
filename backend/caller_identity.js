/* ==========================================================================
   GigSync — AI Caller Identity Resolution
   Accurately maps authenticated sessions and anonymous web/voice callers
   to their true role (Customer vs. Worker vs. Terminal Operator)
   ========================================================================== */

const DB = require('./database');

/**
 * Resolves who is interacting with the AI agent.
 * Rules:
 * 1. An authenticated session (Customer or Worker) defines the true caller.
 * 2. If the portal is 'terminal' and the operator is Admin, a specified callerPhone resolves the physical caller.
 * 3. If unauthenticated, the requested portal/role ('customer' vs 'worker') sets the context.
 * 4. Fallback for general web chatbot is 'customer'.
 */
function resolveAiCaller(session, body = {}) {
    const claimedPhone = (body.callerPhone || '').replace(/\D/g, '');
    const requestedRole = body.role || body.callerRole || (body.portal === 'worker' ? 'worker' : (body.portal === 'terminal' ? 'worker' : 'customer'));
    const requestedCity = body.city || 'Ramanagara';

    const describe = (phone, fallbackRole, fallbackName, fallbackCity) => {
        const worker = DB.getWorkerByPhone(phone);
        const user = DB.getUserByPhone ? DB.getUserByPhone(phone) : null;
        const resolvedRole = fallbackRole || (worker ? 'worker' : (user ? user.role : 'customer'));
        return {
            callerPhone: phone,
            customerId: user && user.role === 'customer' ? user.id : null,
            workerId: worker ? worker.id : null,
            callerRole: resolvedRole || 'customer',
            callerName: (worker ? worker.name : (user ? user.name : fallbackName)) || 'User',
            city: body.city || (worker && worker.city) || (user && user.city) || fallbackCity || 'Ramanagara',
            registeredWorker: Boolean(worker),
            workerProfile: worker || null
        };
    };

    // 1. Authenticated Web / Mobile Session
    if (session && session.user_id) {
        const sessionPhone = (session.phone || '').replace(/\D/g, '');

        // If an Admin operator on the 3.5mm Terminal dialed a specific worker's number:
        if (session.role === 'admin' && (body.portal === 'terminal' || body.isVoiceCall)) {
            if (claimedPhone && claimedPhone !== sessionPhone && claimedPhone.length >= 10) {
                return {
                    ...describe(claimedPhone, 'worker', 'Specialist', session.city),
                    source: 'terminal_operator'
                };
            }
            return {
                callerPhone: claimedPhone.length >= 10 ? claimedPhone : null,
                customerId: null,
                workerId: null,
                callerRole: 'worker',
                callerName: 'Specialist',
                city: session.city || requestedCity,
                registeredWorker: false,
                source: 'terminal_incoming_call'
            };
        }

        // Verified Customer or Worker logged in
        const userProfile = session.role === 'worker' ? DB.getWorkerByUserId(session.user_id) : DB.getUserById(session.user_id);
        const actualRole = session.role || requestedRole || 'customer';
        return {
            callerPhone: sessionPhone,
            customerId: actualRole === 'customer' ? session.user_id : null,
            workerId: actualRole === 'worker' ? (userProfile ? userProfile.id : null) : null,
            callerRole: actualRole,
            callerName: (userProfile && userProfile.name) || session.name || 'User',
            city: (userProfile && userProfile.city) || session.city || requestedCity,
            registeredWorker: actualRole === 'worker',
            workerProfile: actualRole === 'worker' ? (userProfile || DB.getWorkerByPhone(sessionPhone)) : null,
            source: 'verified_session'
        };
    }

    // 2. Hardware 3.5mm Voice Terminal (isolated hardware voice line)
    if (body.portal === 'terminal') {
        if (claimedPhone.length >= 10) {
            return {
                ...describe(claimedPhone, 'worker', 'Specialist', requestedCity),
                source: 'terminal_voice_call'
            };
        }
        return {
            callerPhone: null,
            customerId: null,
            workerId: null,
            callerRole: 'worker',
            callerName: 'Specialist',
            city: requestedCity,
            registeredWorker: false,
            source: 'anonymous_terminal_call'
        };
    }

    // 3. Unauthenticated Web / Phone Caller with known number
    if (claimedPhone.length >= 10) {
        return {
            ...describe(claimedPhone, requestedRole, requestedRole === 'worker' ? 'Specialist' : 'Guest Customer', requestedCity),
            source: 'phone_identified_guest'
        };
    }

    // 4. Anonymous Web Visitor (Chatbot on Home Page / Guest)
    return {
        callerPhone: null,
        customerId: null,
        workerId: null,
        callerRole: requestedRole || 'customer',
        callerName: requestedRole === 'worker' ? 'Specialist' : 'Guest Customer',
        city: requestedCity,
        registeredWorker: false,
        source: 'anonymous_web_guest'
    };
}

// Reads the bearer token off a request and returns the real session row, or null.
function getAuthSession(req) {
    const authHeader = (req.headers && req.headers['authorization']) || '';
    if (authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7).trim();
        return DB.getSession(token);
    }
    return null;
}

module.exports = { resolveAiCaller, getAuthSession };
