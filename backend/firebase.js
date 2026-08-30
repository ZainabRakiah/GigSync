/* ==========================================================================
   GigSync — Firebase Cloud Firestore Synchronization Layer
   Persists Workers, Customers, Jobs, and Availability to Google Cloud Firestore
   ========================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'firebase', 'firebase_config.json');
const FALLBACK_CONFIG_PATH = path.join(__dirname, '..', 'firebase_config.json');

// Default Firebase Configuration.
// NOTE: the real project is 'gigsync-app-tier2' (see firebase_config.json). The old default here
// was 'gigsync-tier2-app', a project that does not exist — so any environment without the config
// file silently wrote to nowhere.
let firebaseConfig = {
    projectId: process.env.FIREBASE_PROJECT_ID || 'gigsync-app-tier2',
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || 'gigsync-app-tier2.firebaseapp.com',
    databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://gigsync-app-tier2.firebaseio.com',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'gigsync-app-tier2.appspot.com'
};

// Load config file if present
const activeConfigPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : (fs.existsSync(FALLBACK_CONFIG_PATH) ? FALLBACK_CONFIG_PATH : null);
if (activeConfigPath) {
    try {
        const fileContent = JSON.parse(fs.readFileSync(activeConfigPath, 'utf8'));
        // Do not let placeholder values committed for local development erase
        // real Vercel environment variables (the old empty apiKey did exactly
        // that, leaving production writes anonymous and rejected).
        const configuredValues = Object.fromEntries(
            Object.entries(fileContent).filter(([, value]) => value !== '' && value !== null && value !== undefined)
        );
        firebaseConfig = { ...firebaseConfig, ...configuredValues };
    } catch (e) {
        console.warn('[Firebase] Could not parse firebase config:', e.message);
    }
}

let cachedAccessToken = null;
let cachedAccessTokenExpiry = 0;

function base64Url(value) {
    return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Vercel stores the service-account JSON as one encrypted environment value.
// Using an OAuth token here makes every Firestore operation server-authenticated
// rather than relying on public Firestore rules or a browser API key.
async function getServiceAccountAccessToken() {
    if (cachedAccessToken && Date.now() < cachedAccessTokenExpiry) return cachedAccessToken;
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) return null;
    let account;
    try { account = JSON.parse(raw); } catch (_) { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON'); }
    if (!account.client_email || !account.private_key) throw new Error('Firebase service account is missing client_email or private_key');
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64Url(JSON.stringify({
        iss: account.client_email, scope: 'https://www.googleapis.com/auth/datastore',
        aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
    }));
    const unsigned = `${header}.${claims}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), account.private_key)
        .toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString();
    const token = await new Promise((resolve, reject) => {
        const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, res => {
            let out = ''; res.on('data', c => out += c); res.on('end', () => {
                try { const parsed = JSON.parse(out); parsed.access_token ? resolve(parsed) : reject(new Error(parsed.error_description || 'Firebase OAuth token was rejected')); } catch (_) { reject(new Error('Firebase OAuth returned invalid JSON')); }
            });
        });
        req.on('error', reject); req.write(body); req.end();
    });
    cachedAccessToken = token.access_token;
    cachedAccessTokenExpiry = Date.now() + Math.max(60, Number(token.expires_in || 3600) - 120) * 1000;
    return cachedAccessToken;
}

// REST API Helper for Cloud Firestore
async function firestoreRequest(collection, documentId, method = 'PATCH', documentData = {}) {
    const accessToken = await getServiceAccountAccessToken();
    return new Promise((resolve) => {
        if (!firebaseConfig.projectId) {
            return resolve({ status: 'skipped', ok: false, message: 'No projectId configured', collection, documentId });
        }

        const projectId = firebaseConfig.projectId;
        const firestoreFields = {};

        // Convert JS object to Firestore typed format
        for (const [key, val] of Object.entries(documentData)) {
            if (typeof val === 'string') {
                firestoreFields[key] = { stringValue: val };
            } else if (typeof val === 'number') {
                if (Number.isInteger(val)) firestoreFields[key] = { integerValue: String(val) };
                else firestoreFields[key] = { doubleValue: val };
            } else if (typeof val === 'boolean') {
                firestoreFields[key] = { booleanValue: val };
            } else if (val === null || val === undefined) {
                firestoreFields[key] = { nullValue: null };
            } else {
                firestoreFields[key] = { stringValue: JSON.stringify(val) };
            }
        }

        const apiKeyParam = !accessToken && firebaseConfig.apiKey ? `?key=${encodeURIComponent(firebaseConfig.apiKey)}` : '';
        const isWrite = method !== 'GET';
        const bodyData = isWrite ? JSON.stringify({ fields: firestoreFields }) : null;
        const pathName = `/v1/projects/${projectId}/databases/(default)/documents/${collection}/${encodeURIComponent(documentId)}${apiKeyParam}`;

        const options = {
            hostname: 'firestore.googleapis.com',
            port: 443,
            path: pathName,
            method: method,
            headers: isWrite
                ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyData), ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) }
                : { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) }
        };

        const req = https.request(options, (res) => {
            let resBody = '';
            res.on('data', chunk => { resBody += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    let parsed = null;
                    try { parsed = JSON.parse(resBody); } catch (_) {}
                    resolve({ status: 'success', ok: true, statusCode: res.statusCode, collection, documentId, document: parsed });
                } else {
                    // Surface the reason. A 403 "Cloud Firestore API has not been used in project ..."
                    // means the database was never enabled — the caller must be able to see that.
                    let reason = resBody;
                    try {
                        const parsed = JSON.parse(resBody);
                        if (parsed && parsed.error && parsed.error.message) reason = parsed.error.message;
                    } catch (_) {}
                    resolve({ status: 'error', ok: false, statusCode: res.statusCode, message: reason, collection, documentId });
                }
            });
        });

        req.on('error', (err) => {
            resolve({ status: 'error', ok: false, message: err.message, collection, documentId });
        });

        if (isWrite) req.write(bodyData);
        req.end();
    });
}

// Convert a Firestore typed document back into a plain JS object.
function decodeFirestoreDocument(doc) {
    if (!doc || !doc.fields) return null;
    const out = {};
    for (const [key, wrapper] of Object.entries(doc.fields)) {
        if ('stringValue' in wrapper) out[key] = wrapper.stringValue;
        else if ('integerValue' in wrapper) out[key] = Number(wrapper.integerValue);
        else if ('doubleValue' in wrapper) out[key] = Number(wrapper.doubleValue);
        else if ('booleanValue' in wrapper) out[key] = wrapper.booleanValue;
        else if ('nullValue' in wrapper) out[key] = null;
        else out[key] = wrapper;
    }
    return out;
}

const localSnapshotStore = {
    users: {},
    sessions: {},
    workers: {},
    customers: {},
    jobs: {},
    worker_availability: {}
};

const FirebaseSync = {
    isServerAuthenticated() {
        return Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    },
    getConfig() {
        return firebaseConfig;
    },

    saveConfig(newConfig) {
        firebaseConfig = { ...firebaseConfig, ...newConfig };
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(firebaseConfig, null, 2), 'utf8');
        return firebaseConfig;
    },

    // LOCAL cache of the last payload we attempted to send. This is NOT proof that anything
    // reached Cloud Firestore — it is populated before the network call and stays populated
    // even when the write fails. Use readDocument() to verify a real Firestore record.
    getDocument(collection, docId) {
        return localSnapshotStore[collection]?.[docId] || null;
    },

    getLocalSnapshot(collection, docId) {
        return localSnapshotStore[collection]?.[docId] || null;
    },

    // REAL verification: GET the document back from Cloud Firestore over the wire.
    async readDocument(collection, docId) {
        const res = await firestoreRequest(collection, docId, 'GET');
        if (res.ok) {
            return { ok: true, statusCode: res.statusCode, collection, documentId: docId, data: decodeFirestoreDocument(res.document) };
        }
        return { ok: false, statusCode: res.statusCode || 0, collection, documentId: docId, data: null, message: res.message };
    },

    async syncUser(user) {
        if (!user || !user.phone) return { status: 'skipped', ok: false, message: 'No user supplied.' };
        const docId = `user_${user.phone}`;
        const payload = { name: user.name, phone: user.phone, email: user.email || '', role: user.role, password_hash: user.password_hash || '', city: user.city || 'Ramanagara', area: user.area || 'Town', updated_at: new Date().toISOString() };
        localSnapshotStore.users[docId] = payload;
        return firestoreRequest('users', docId, 'PATCH', payload);
    },

    async syncSession(session) {
        if (!session || !session.token) return { status: 'skipped', ok: false, message: 'No session supplied.' };
        const payload = { token: session.token, user_id: Number(session.user_id || 0), phone: session.phone || '', role: session.role || 'customer', created_at: session.created_at || new Date().toISOString() };
        localSnapshotStore.sessions[`session_${session.token}`] = payload;
        return firestoreRequest('sessions', `session_${session.token}`, 'PATCH', payload);
    },

    // 1. Sync Worker to Firestore 'workers' collection
    async syncWorker(worker) {
        if (!worker || !worker.id) {
            return { status: 'skipped', ok: false, message: 'No worker record supplied to syncWorker.' };
        }
        // Phone is the platform's stable worker identity; SQLite ids are not
        // stable across Vercel instances.
        const docId = `worker_${worker.phone}`;
        const payload = {
            workerId: Number(worker.id),
            name: worker.name,
            phone: worker.phone,
            trade: worker.trade,
            service: worker.service,
            skills: worker.skills || '',
            tools: worker.tools || '',
            rating: Number(worker.rating || 5.0),
            price: Number(worker.price || 300),
            jobs_completed: Number(worker.jobs_completed || 0),
            is_available: Boolean(worker.is_available),
            is_verified: Boolean(worker.is_verified),
            city: worker.city || 'Ramanagara',
            area: worker.area || 'Town',
            service_areas: worker.service_areas || `${worker.city}, Nearby Areas`,
            about: worker.about || '',
            updated_at: new Date().toISOString()
        };
        localSnapshotStore.workers[docId] = payload;

        try {
            const res = await firestoreRequest('workers', docId, 'PATCH', payload);
            console.log(`[Firebase Sync] Worker #${worker.id} (${worker.name}) synced to Firestore collection 'workers'. Result:`, res.status, res.ok ? '' : `-> ${String(res.message || '').slice(0, 200)}`);
            return res;
        } catch (e) {
            console.warn('[Firebase Sync] Worker sync failed:', e.message);
            return { status: 'error', ok: false, message: e.message, collection: 'workers', documentId: docId };
        }
    },

    // 2. Sync Customer to Firestore 'customers' collection
    async syncCustomer(customer) {
        if (!customer || !customer.id) {
            return { status: 'skipped', ok: false, message: 'No customer record supplied to syncCustomer.' };
        }
        const docId = `customer_${customer.phone}`;
        const payload = {
            customerId: Number(customer.id),
            name: customer.name,
            phone: customer.phone,
            email: customer.email || '',
            city: customer.city || 'Ramanagara',
            area: customer.area || 'Town',
            updated_at: new Date().toISOString()
        };
        localSnapshotStore.customers[docId] = payload;

        try {
            const res = await firestoreRequest('customers', docId, 'PATCH', payload);
            console.log(`[Firebase Sync] Customer #${customer.id} (${customer.name}) synced to Firestore collection 'customers'. Result:`, res.status, res.ok ? '' : `-> ${String(res.message || '').slice(0, 200)}`);
            return res;
        } catch (e) {
            console.warn('[Firebase Sync] Customer sync failed:', e.message);
            return { status: 'error', ok: false, message: e.message, collection: 'customers', documentId: docId };
        }
    },

    // 3. Sync Job / Booking to Firestore 'jobs' collection
    async syncJob(job) {
        if (!job || !job.id) {
            return { status: 'skipped', ok: false, message: 'No job record supplied to syncJob.' };
        }
        const docId = `job_${job.id}`;
        const payload = {
            jobId: String(job.id),
            customer_phone: job.customer_phone,
            customer_name: job.customer_name,
            worker_id: job.worker_id ? Number(job.worker_id) : 0,
            worker_phone: job.worker_phone || '',
            worker_name: job.worker_name || 'Broadcasting',
            service: job.service,
            problem_description: job.problem_description,
            location: job.location,
            city: job.city,
            requested_date: job.requested_date,
            requested_time: job.requested_time,
            budget: job.budget,
            final_price: job.final_price ? Number(job.final_price) : 350,
            status: job.status || 'Requested',
            payment_status: job.payment_status || 'Pending',
            payment_method: job.payment_method || 'Cash',
            created_at: job.created_at || new Date().toISOString()
        };
        localSnapshotStore.jobs[docId] = payload;

        try {
            const res = await firestoreRequest('jobs', docId, 'PATCH', payload);
            console.log(`[Firebase Sync] Job #${job.id} (${job.service}) synced to Firestore collection 'jobs'. Result:`, res.status, res.ok ? '' : `-> ${String(res.message || '').slice(0, 200)}`);
            return res;
        } catch (e) {
            console.warn('[Firebase Sync] Job sync failed:', e.message);
            return { status: 'error', ok: false, message: e.message, collection: 'jobs', documentId: docId };
        }
    },

    // 4. Sync Worker Availability Slot to Firestore 'worker_availability' collection
    async syncAvailability(slot) {
        if (!slot || !slot.id) {
            return { status: 'skipped', ok: false, message: 'No availability slot supplied to syncAvailability.' };
        }
        // SQLite row ids are local to a Vercel instance. A stable business key
        // prevents each cold start from creating a duplicate Firestore slot.
        const safeDate = String(slot.date_str || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
        const safePattern = String(slot.pattern || 'once').replace(/[^a-zA-Z0-9_-]/g, '_');
        const docId = `avail_${slot.worker_phone}_${safeDate}_${safePattern}`;
        const payload = {
            slotId: Number(slot.id),
            workerId: slot.worker_id ? Number(slot.worker_id) : 0,
            workerPhone: slot.worker_phone,
            trade: slot.trade,
            dateStr: slot.date_str,
            startTime: slot.start_time,
            endTime: slot.end_time,
            isAvailable: Boolean(slot.is_available),
            notes: slot.notes || '',
            pattern: slot.pattern || 'once',
            daysOfWeek: slot.days_of_week || '[]',
            rangeStart: slot.range_start || slot.date_str,
            rangeEnd: slot.range_end || '',
            updated_at: new Date().toISOString()
        };
        localSnapshotStore.worker_availability[docId] = payload;

        try {
            const res = await firestoreRequest('worker_availability', docId, 'PATCH', payload);
            console.log(`[Firebase Sync] Availability slot #${slot.id} synced to Firestore collection 'worker_availability'. Result:`, res.status, res.ok ? '' : `-> ${String(res.message || '').slice(0, 200)}`);
            return res;
        } catch (e) {
            console.warn('[Firebase Sync] Availability sync failed:', e.message);
            return { status: 'error', ok: false, message: e.message, collection: 'worker_availability', documentId: docId };
        }
    },

    // 5. Clean / Delete Collections in Firestore
    async listDocuments(collection) {
        if (!firebaseConfig.projectId) return [];
        const accessToken = await getServiceAccountAccessToken();
        const apiKeyParam = !accessToken && firebaseConfig.apiKey ? `?key=${encodeURIComponent(firebaseConfig.apiKey)}` : '';
        const pathName = `/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/${collection}${apiKeyParam}`;
        return new Promise(resolve => {
            const req = https.request({
                hostname: 'firestore.googleapis.com',
                port: 443,
                path: pathName,
                method: 'GET',
                headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
            }, (res) => {
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(d);
                        resolve(parsed.documents || []);
                    } catch (e) {
                        resolve([]);
                    }
                });
            });
            req.on('error', () => resolve([]));
            req.end();
        });
    },

    async listCollectionData(collection) {
        const docs = await this.listDocuments(collection);
        return docs.map(decodeFirestoreDocument).filter(Boolean);
    },

    async deleteDocument(collection, docId) {
        return firestoreRequest(collection, docId, 'DELETE');
    },

    async clearCollection(collection) {
        if (localSnapshotStore[collection]) localSnapshotStore[collection] = {};
        const docs = await this.listDocuments(collection);
        if (Array.isArray(docs)) {
            for (const doc of docs) {
                if (doc && doc.name) {
                    const parts = doc.name.split('/');
                    const docId = parts[parts.length - 1];
                    await this.deleteDocument(collection, docId).catch(() => {});
                }
            }
        }
    },

    async clearAllData() {
        localSnapshotStore.workers = {};
        localSnapshotStore.users = {};
        localSnapshotStore.sessions = {};
        localSnapshotStore.customers = {};
        localSnapshotStore.jobs = {};
        localSnapshotStore.worker_availability = {};
        await Promise.allSettled([
            this.clearCollection('workers'),
            this.clearCollection('users'),
            this.clearCollection('sessions'),
            this.clearCollection('worker_availability'),
            this.clearCollection('jobs'),
            this.clearCollection('customers')
        ]);
        return { status: 'success', message: 'Cleared Firestore dummy test data' };
    }
};

module.exports = FirebaseSync;
