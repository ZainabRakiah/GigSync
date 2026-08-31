/* ==========================================================================
   GigSync — Central SQLite Database Layer with Firebase Firestore Sync
   Dual Persistence: Instant Local SQLite + Real-Time Firebase Cloud Sync
   ========================================================================== */

let DatabaseSync = null;
try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
} catch (e) {
    DatabaseSync = null;
}

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const FirebaseSync = require('./firebase');

// Voice turns use labels such as "Tomorrow" while calendar bookings use ISO
// dates. Store and compare one canonical key so those two entry points agree.
// Do not use toISOString() for a local calendar date: in IST, local midnight is
// still the previous UTC day and bookings would silently move backwards.
function formatLocalDateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseNaturalCalendarDate(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const normalized = raw
        .replace(/\bof\b/gi, ' ')
        .replace(/,/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const monthLookup = {
        january: 0, jan: 0,
        february: 1, feb: 1,
        march: 2, mar: 2,
        april: 3, apr: 3,
        may: 4,
        june: 5, jun: 5,
        july: 6, jul: 6,
        august: 7, aug: 7,
        september: 8, sep: 8, sept: 8,
        october: 9, oct: 9,
        november: 10, nov: 10,
        december: 11, dec: 11
    };

    const base = new Date();
    base.setHours(0, 0, 0, 0);

    const dayFirst = normalized.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:\s+(\d{4}))?$/i);
    if (dayFirst) {
        const day = Number(dayFirst[1]);
        const month = monthLookup[dayFirst[2].toLowerCase()];
        const year = dayFirst[3] ? Number(dayFirst[3]) : base.getFullYear();
        if (month !== undefined) {
            let date = new Date(year, month, day);
            if (!dayFirst[3] && date < base) date = new Date(year + 1, month, day);
            if (date.getFullYear() === (dayFirst[3] ? year : date.getFullYear()) && date.getMonth() === month && date.getDate() === day) {
                return date;
            }
        }
    }

    const monthFirst = normalized.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?$/i);
    if (monthFirst) {
        const month = monthLookup[monthFirst[1].toLowerCase()];
        const day = Number(monthFirst[2]);
        const year = monthFirst[3] ? Number(monthFirst[3]) : base.getFullYear();
        if (month !== undefined) {
            let date = new Date(year, month, day);
            if (!monthFirst[3] && date < base) date = new Date(year + 1, month, day);
            if (date.getMonth() === month && date.getDate() === day) {
                return date;
            }
        }
    }

    return null;
}

function normalizeDateKey(value) {
    const raw = String(value || '').trim();
    if (!raw) return raw;
    const lower = raw.toLowerCase();
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    if (lower === 'today') return formatLocalDateKey(base);
    if (lower === 'tomorrow') {
        base.setDate(base.getDate() + 1);
        return formatLocalDateKey(base);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const natural = parseNaturalCalendarDate(raw);
    if (natural) return formatLocalDateKey(natural);
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? raw : formatLocalDateKey(parsed);
}

// JavaScript parses an ISO date-only string as UTC. That shifts the calendar
// day in time zones west of UTC, which breaks weekly availability matching.
function parseDateOnly(value) {
    if (value instanceof Date) return new Date(value.getTime());
    const raw = String(value || '').trim();
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return new Date(raw);
}

function normalizePhone(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.length > 10 ? digits.slice(-10) : digits;
}

function normalizeDaysOfWeekKey(daysOfWeek = []) {
    if (!Array.isArray(daysOfWeek)) return '[]';
    const cleaned = [...new Set(daysOfWeek.map(n => Number(n)).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);
    return JSON.stringify(cleaned);
}

const VALID_JOB_STATUSES = new Set([
    'Requested', 'Confirmed', 'Assigned', 'Accepted', 'On the Way',
    'In Progress', 'Completed', 'Cancelled', 'Cancelled (Worker)'
]);

let db = null;
let useMemoryFallback = false;

if (DatabaseSync) {
    try {
        let dbFile = process.env.GIGSYNC_DB_PATH || path.join(__dirname, '..', 'gigsync.db');
        const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NOW_REGION);
        
        if (isServerless) {
            const tmpPath = path.join('/tmp', 'gigsync.db');
            try {
                if (fs.existsSync(dbFile) && !fs.existsSync(tmpPath)) {
                    fs.copyFileSync(dbFile, tmpPath);
                }
                dbFile = tmpPath;
            } catch (_) {}
        }

        try {
            db = new DatabaseSync(dbFile);
            db.exec('PRAGMA foreign_keys = ON;');
            db.exec('CREATE TABLE IF NOT EXISTS _health_check (id INTEGER PRIMARY KEY);');
        } catch (writeErr) {
            // Read-only filesystem detected -> copy to /tmp and retry
            try {
                const tmpPath = path.join('/tmp', 'gigsync.db');
                const srcPath = path.join(__dirname, '..', 'gigsync.db');
                if (fs.existsSync(srcPath)) {
                    fs.copyFileSync(srcPath, tmpPath);
                }
                db = new DatabaseSync(tmpPath);
                db.exec('PRAGMA foreign_keys = ON;');
                db.exec('CREATE TABLE IF NOT EXISTS _health_check (id INTEGER PRIMARY KEY);');
            } catch (tmpErr) {
                // If /tmp also fails, use in-memory SQLite database
                try {
                    db = new DatabaseSync(':memory:');
                    db.exec('PRAGMA foreign_keys = ON;');
                } catch (_) {
                    db = null;
                    useMemoryFallback = true;
                }
            }
        }
    } catch (e) {
        db = null;
        useMemoryFallback = true;
    }
} else {
    useMemoryFallback = true;
}

// In-Memory Fallback Store (Used on Vercel Serverless if native SQLite is unavailable)
const memoryStore = {
    users: [
        {
            id: 1,
            name: 'Master Platform Administrator',
            phone: '9999999999',
            email: 'shiyazabdulazeez@gmail.com',
            role: 'admin',
            password_hash: crypto.scryptSync('admin@gigsync2026', 'gigsync_salt_tier2', 32).toString('hex'),
            city: 'Ramanagara',
            area: 'Headquarters'
        }
    ],
    sessions: {},
    workers: [],
    customers: [],
    jobs: [],
    availability: {},
    workerJobActions: [],
    callLogs: []
};

// Helper for unique Job IDs (e.g. GS-1048)
function generateJobId() {
    const rand = Math.floor(1000 + Math.random() * 9000);
    return `GS-${rand}`;
}

// Password hashing helper
function hashPassword(password) {
    return crypto.scryptSync(password, 'gigsync_salt_tier2', 32).toString('hex');
}

function verifyPassword(password, hash) {
    const hashedAttempt = crypto.scryptSync(password, 'gigsync_salt_tier2', 32).toString('hex');
    return hashedAttempt === hash;
}

// Initialize Database Tables & Seed the 3 Test Workers
function initDatabase() {
    if (!db) return;
    try {
        db.exec(`
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT NOT NULL UNIQUE,
            email TEXT,
            role TEXT NOT NULL CHECK(role IN ('customer', 'worker', 'admin')),
            password_hash TEXT NOT NULL,
            city TEXT NOT NULL DEFAULT 'Ramanagara',
            area TEXT NOT NULL DEFAULT 'Town',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            phone TEXT NOT NULL,
            role TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS workers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER UNIQUE,
            name TEXT NOT NULL,
            phone TEXT NOT NULL UNIQUE,
            trade TEXT NOT NULL,
            service TEXT NOT NULL,
            skills TEXT DEFAULT '',
            tools TEXT DEFAULT 'Standard tool kit',
            rating REAL DEFAULT 5.0,
            km REAL DEFAULT 1.5,
            jobs_completed INTEGER DEFAULT 0,
            experience_years INTEGER DEFAULT 2,
            price INTEGER DEFAULT 300,
            is_available INTEGER DEFAULT 1,
            is_verified INTEGER DEFAULT 1,
            initials TEXT NOT NULL,
            city TEXT NOT NULL DEFAULT 'Ramanagara',
            area TEXT NOT NULL DEFAULT 'Town',
            service_areas TEXT NOT NULL DEFAULT 'Ramanagara, Nearby Areas',
            about TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER UNIQUE,
            name TEXT NOT NULL,
            phone TEXT NOT NULL UNIQUE,
            email TEXT,
            city TEXT NOT NULL DEFAULT 'Ramanagara',
            area TEXT NOT NULL DEFAULT 'Town',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            customer_id INTEGER,
            customer_phone TEXT NOT NULL,
            customer_name TEXT NOT NULL,
            worker_id INTEGER,
            worker_phone TEXT,
            worker_name TEXT,
            service TEXT NOT NULL,
            problem_description TEXT NOT NULL,
            location TEXT NOT NULL,
            city TEXT NOT NULL DEFAULT 'Ramanagara',
            requested_date TEXT NOT NULL DEFAULT 'Today',
            requested_time TEXT NOT NULL DEFAULT 'Immediate',
            requested_end_time TEXT,
            budget TEXT NOT NULL,
            final_price INTEGER,
            status TEXT DEFAULT 'Requested',
            payment_status TEXT DEFAULT 'Pending',
            payment_method TEXT DEFAULT 'Cash',
            rating INTEGER,
            review TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME,
            FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE SET NULL,
            FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS worker_availability (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            worker_id INTEGER,
            worker_phone TEXT NOT NULL,
            trade TEXT NOT NULL,
            date_str TEXT NOT NULL,
            start_time TEXT NOT NULL,
            end_time TEXT NOT NULL,
            is_available INTEGER DEFAULT 1,
            notes TEXT,
            pattern TEXT NOT NULL DEFAULT 'once',
            days_of_week TEXT NOT NULL DEFAULT '[]',
            range_start TEXT,
            range_end TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS worker_job_actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            worker_id INTEGER NOT NULL,
            job_id TEXT NOT NULL,
            action TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(worker_id, job_id, action),
            FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE,
            FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS call_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            caller_phone TEXT NOT NULL,
            caller_role TEXT NOT NULL DEFAULT 'customer',
            transcript TEXT NOT NULL,
            intent_detected TEXT,
            actions_taken TEXT,
            duration_seconds INTEGER DEFAULT 0,
            status TEXT DEFAULT 'Completed',
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS voice_sessions (
            session_id TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
    `);

    // These indexes keep the cross-role booking reads fast as the marketplace
    // grows. They also make the intended lookup keys explicit.
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_jobs_customer_phone ON jobs(customer_phone);
        CREATE INDEX IF NOT EXISTS idx_jobs_worker_phone ON jobs(worker_phone);
        CREATE INDEX IF NOT EXISTS idx_jobs_worker_status ON jobs(worker_id, status);
        CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
        CREATE INDEX IF NOT EXISTS idx_availability_worker_date ON worker_availability(worker_id, date_str);
        CREATE INDEX IF NOT EXISTS idx_worker_job_actions_worker_job ON worker_job_actions(worker_id, job_id);
    `);

    // Ensure Master Admin account exists
    const adminPhone = '9999999999';
    const adminUser = db.prepare('SELECT * FROM users WHERE phone = ?').get(adminPhone);
    if (!adminUser) {
        const pHash = hashPassword('admin@gigsync2026');
        db.prepare(`
            INSERT INTO users (name, phone, email, role, password_hash, city, area)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('Master Platform Administrator', adminPhone, 'shiyazabdulazeez@gmail.com', 'admin', pHash, 'Ramanagara', 'Headquarters');
    }

    console.log('✅ [Database] Initialized clean database tables with zero dummy workers or bookings.');

    // Non-destructive migration: add pattern columns to existing worker_availability rows
    const existingCols = db.prepare(`PRAGMA table_info(worker_availability)`).all().map(c => c.name);
    if (!existingCols.includes('pattern'))    db.exec(`ALTER TABLE worker_availability ADD COLUMN pattern TEXT NOT NULL DEFAULT 'once'`);
    if (!existingCols.includes('days_of_week')) db.exec(`ALTER TABLE worker_availability ADD COLUMN days_of_week TEXT NOT NULL DEFAULT '[]'`);
    if (!existingCols.includes('range_start')) db.exec(`ALTER TABLE worker_availability ADD COLUMN range_start TEXT`);
    if (!existingCols.includes('range_end'))   db.exec(`ALTER TABLE worker_availability ADD COLUMN range_end TEXT`);

    const workerActionCols = db.prepare(`PRAGMA table_info(worker_job_actions)`).all().map(c => c.name);
    if (!workerActionCols.includes('action')) db.exec(`ALTER TABLE worker_job_actions ADD COLUMN action TEXT NOT NULL DEFAULT 'declined'`);

    const jobCols = db.prepare(`PRAGMA table_info(jobs)`).all().map(c => c.name);
    if (!jobCols.includes('requested_end_time')) db.exec(`ALTER TABLE jobs ADD COLUMN requested_end_time TEXT`);

    } catch (e) {
        console.warn('[Database Init Exception]:', e.message);
    }
}

initDatabase();

/* ==========================================================================
   FIREBASE MIRROR HELPER
   Returns a promise resolving to the REAL Firestore outcome so callers can
   verify the cloud write instead of assuming it worked. Firestore failures
   never break the local write — SQLite stays authoritative — but they are
   reported truthfully rather than swallowed.
   ========================================================================== */
function mirrorToFirebase({ worker = null, slot = null, job = null, customer = null }) {
    const jobs = [];
    if (worker) jobs.push(['worker', FirebaseSync.syncWorker(worker)]);
    if (slot) jobs.push(['worker_availability', FirebaseSync.syncAvailability(slot)]);
    if (job) jobs.push(['job', FirebaseSync.syncJob(job)]);
    if (customer) jobs.push(['customer', FirebaseSync.syncCustomer(customer)]);

    if (jobs.length === 0) {
        return Promise.resolve({ ok: null, message: 'Nothing to mirror to Firebase.', collections: [] });
    }

    return Promise.all(jobs.map(([label, p]) =>
        Promise.resolve(p)
            .then(res => ({ label, ok: Boolean(res && res.status === 'success'), detail: res || null }))
            .catch(err => ({ label, ok: false, detail: { status: 'error', message: err.message } }))
    )).then(results => {
        const failed = results.filter(r => !r.ok);
        return {
            ok: failed.length === 0,
            collections: results.map(r => r.label),
            results,
            message: failed.length === 0
                ? `Mirrored to Firestore: ${results.map(r => r.label).join(', ')}.`
                : `Firestore write failed for ${failed.map(f => f.label).join(', ')}: ${failed.map(f => (f.detail && f.detail.message ? String(f.detail.message).slice(0, 240) : 'unknown error')).join(' | ')}`
        };
    });
}

/* ==========================================================================
   CHANGE NOTIFICATIONS

   Every write below funnels through this so open browser pages can be told what
   changed the moment it changes, instead of showing whatever the customer's
   screen happened to load minutes ago.

   Why it is here and not in the API layer: a worker's availability can be changed
   by a REST call, by the AI voice agent, or by the 3.5mm terminal. Notifying from
   each of those separately guarantees one of them eventually gets forgotten. This
   is the one place they all pass through.

   Listeners must never break a write, so each is wrapped.
   ========================================================================== */

const changeListeners = new Set();
let lastCloudHydrationAt = 0;
let cloudHydrationInFlight = null;

function emitChange(entity, detail = {}) {
    if (changeListeners.size === 0) return;
    const event = { entity, ...detail, at: new Date().toISOString() };
    for (const listener of changeListeners) {
        try {
            listener(event);
        } catch (err) {
            console.warn('[DB Change Listener Error]:', err.message);
        }
    }
}

/* ==========================================================================
   DATABASE OPERATIONS & REPOSITORY METHODS
   ========================================================================== */

const DB = {
    // Subscribe to writes. Returns an unsubscribe function.
    onChange(listener) {
        changeListeners.add(listener);
        return () => changeListeners.delete(listener);
    },

    // Serverless instances have isolated local SQLite files. Before serving a
    // Vercel request, rebuild their working cache from Firestore so reads,
    // availability checks, bookings and cancellations all share one source.
    async hydrateFromFirestore() {
        if (!FirebaseSync.isServerAuthenticated || !FirebaseSync.isServerAuthenticated()) return { skipped: true, reason: 'Firebase service account is not configured' };
        if (Date.now() - lastCloudHydrationAt < 5000) return { cached: true };
        if (cloudHydrationInFlight) return cloudHydrationInFlight;
        cloudHydrationInFlight = (async () => {
            const [users, sessions, workers, availability, jobs] = await Promise.all([
                FirebaseSync.listCollectionData('users'), FirebaseSync.listCollectionData('sessions'),
                FirebaseSync.listCollectionData('workers'), FirebaseSync.listCollectionData('worker_availability'), FirebaseSync.listCollectionData('jobs')
            ]);
            if (!db) return { users: users.length, sessions: sessions.length, workers: workers.length, availability: availability.length, jobs: jobs.length };

            for (const user of users) {
                if (!user.phone || !user.role || !user.password_hash) continue;
                const existing = this.getUserByPhone(user.phone);
                if (existing) db.prepare('UPDATE users SET name=?, email=?, role=?, password_hash=?, city=?, area=? WHERE phone=?').run(user.name || 'User', user.email || null, user.role, user.password_hash, user.city || 'Ramanagara', user.area || 'Town', user.phone);
                else db.prepare('INSERT INTO users (name, phone, email, role, password_hash, city, area) VALUES (?, ?, ?, ?, ?, ?, ?)').run(user.name || 'User', user.phone, user.email || null, user.role, user.password_hash, user.city || 'Ramanagara', user.area || 'Town');
            }
            for (const session of sessions) {
                if (!session.token || !session.phone || !session.role) continue;
                const user = this.getUserByPhone(session.phone);
                if (!user) continue;
                db.prepare('INSERT OR REPLACE INTO sessions (token, user_id, phone, role) VALUES (?, ?, ?, ?)').run(session.token, user.id, session.phone, session.role);
            }

            for (const w of workers) {
                if (!w.phone) continue;
                const existing = this.getWorkerByPhone(w.phone);
                const values = [w.name || 'Worker', w.trade || 'Skilled Specialist', w.service || String(w.trade || 'general').toLowerCase(), w.skills || '', w.tools || 'Standard tool kit', Number(w.rating || 5), Number(w.price || 300), Number(w.jobs_completed || 0), w.is_available === false ? 0 : 1, w.is_verified === false ? 0 : 1, w.city || 'Ramanagara', w.area || 'Town', w.service_areas || `${w.city || 'Ramanagara'}, Nearby Areas`, w.about || '', w.phone];
                if (existing) {
                    db.prepare(`UPDATE workers SET name=?, trade=?, service=?, skills=?, tools=?, rating=?, price=?, jobs_completed=?, is_available=?, is_verified=?, city=?, area=?, service_areas=?, about=? WHERE phone=?`).run(...values);
                } else {
                    const initials = (w.name || 'WK').split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase();
                    db.prepare(`INSERT INTO workers (name, phone, trade, service, skills, tools, rating, price, jobs_completed, is_available, is_verified, initials, city, area, service_areas, about) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(w.name || 'Worker', w.phone, w.trade || 'Skilled Specialist', w.service || String(w.trade || 'general').toLowerCase(), w.skills || '', w.tools || 'Standard tool kit', Number(w.rating || 5), Number(w.price || 300), Number(w.jobs_completed || 0), w.is_available === false ? 0 : 1, w.is_verified === false ? 0 : 1, initials, w.city || 'Ramanagara', w.area || 'Town', w.service_areas || `${w.city || 'Ramanagara'}, Nearby Areas`, w.about || '');
                }
            }
            for (const slot of availability) {
                const worker = slot.workerPhone ? this.getWorkerByPhone(slot.workerPhone) : null;
                if (!worker || !slot.dateStr || !slot.startTime || !slot.endTime) continue;
                let daysOfWeek = [];
                try { daysOfWeek = Array.isArray(slot.daysOfWeek) ? slot.daysOfWeek : JSON.parse(slot.daysOfWeek || '[]'); } catch (_) {}
                this.setWorkerAvailabilitySlot({ workerId: worker.id, workerPhone: worker.phone, trade: slot.trade || worker.trade, dateStr: slot.dateStr, startTime: slot.startTime, endTime: slot.endTime, isAvailable: slot.isAvailable !== false, notes: slot.notes || '', pattern: slot.pattern || 'once', daysOfWeek, rangeStart: slot.rangeStart || slot.dateStr, rangeEnd: slot.rangeEnd || null });
            }
            for (const job of jobs) {
                if (!job.jobId || !job.customer_phone) continue;
                const worker = job.worker_phone ? this.getWorkerByPhone(job.worker_phone) : null;
                const existing = this.getJobById(job.jobId);
                if (!existing) this.createJob({ id: job.jobId, customer_phone: job.customer_phone, customer_name: job.customer_name || 'Customer', worker_id: worker ? worker.id : null, worker_phone: worker ? worker.phone : null, worker_name: job.worker_name || 'Broadcasting', service: job.service || 'General Service', problem_description: job.problem_description || '', location: job.location || 'Town Area', city: job.city || 'Ramanagara', requested_date: job.requested_date || 'Today', requested_time: job.requested_time || 'Immediate', requested_end_time: job.requested_end_time || null, budget: job.budget || '₹350', status: job.status || 'Requested', payment_method: job.payment_method || 'Cash' });
                else this.updateJobStatus(job.jobId, job.status || existing.status, worker ? worker.id : null, worker ? worker.name : null, worker ? worker.phone : null);
            }
            lastCloudHydrationAt = Date.now();
            return { users: users.length, sessions: sessions.length, workers: workers.length, availability: availability.length, jobs: jobs.length };
        })();
        try { return await cloudHydrationInFlight; } finally { cloudHydrationInFlight = null; }
    },

    // ---------------- AUTH & USER OPERATIONS ----------------
    createUser({ name, phone, email, role, password, city = 'Ramanagara', area = 'Town' }) {
        const cleanPhone = (phone || '').replace(/\D/g, '');
        if (!String(name || '').trim()) throw new Error('Name is required.');
        if (cleanPhone.length !== 10) throw new Error('A valid 10-digit phone number is required.');
        if (!['customer', 'worker', 'admin'].includes(role)) throw new Error('A valid account role is required.');
        if (!String(password || '')) throw new Error('Password is required.');
        const pHash = hashPassword(password);

        if (!db) {
            const existingUser = memoryStore.users.find(u => u.phone === cleanPhone);
            if (existingUser) {
                Object.assign(existingUser, {
                    name: name || existingUser.name,
                    email: email || existingUser.email,
                    role: role || existingUser.role,
                    password_hash: pHash || existingUser.password_hash,
                    city: city || existingUser.city,
                    area: area || existingUser.area
                });
                if (role === 'worker') {
                    const existingWorker = memoryStore.workers.find(w => w.phone === cleanPhone);
                    if (existingWorker) {
                        existingWorker.user_id = existingUser.id;
                        existingWorker.name = name || existingWorker.name;
                        existingWorker.city = city || existingWorker.city;
                        existingWorker.area = area || existingWorker.area;
                    } else {
                        const initials = (name || existingUser.name || 'WK').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() || 'WK';
                        const worker = { id: memoryStore.workers.length + 1, user_id: existingUser.id, name: name || existingUser.name, phone: cleanPhone, trade: 'General Specialist', service: 'general', initials, city, area, service_areas: `${city}, Nearby Areas`, rating: 5.0, km: 1.5, jobs_completed: 0, price: 300, is_available: 1, is_verified: 1, skills: '', tools: 'Standard tool kit', experience_years: 2, about: '' };
                        memoryStore.workers.push(worker);
                    }
                }
                FirebaseSync.syncUser(existingUser).catch(e => console.warn('[Firebase Sync Error]:', e));
                return existingUser;
            }

            const userId = memoryStore.users.length + 1;
            const user = { id: userId, name, phone: cleanPhone, email: email || null, role, password_hash: pHash, city, area, created_at: new Date().toISOString() };
            memoryStore.users.push(user);
            FirebaseSync.syncUser(user).catch(e => console.warn('[Firebase Sync Error]:', e));
            if (role === 'worker') {
                const initials = name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() || 'WK';
                const worker = { id: memoryStore.workers.length + 1, user_id: userId, name, phone: cleanPhone, trade: 'General Specialist', service: 'general', initials, city, area, service_areas: `${city}, Nearby Areas`, rating: 5.0, km: 1.5, jobs_completed: 0, price: 300, is_available: 1, is_verified: 1, skills: '', tools: 'Standard tool kit', experience_years: 2, about: '' };
                memoryStore.workers.push(worker);
                FirebaseSync.syncWorker(worker).catch(e => console.warn('[Firebase Sync Error]:', e));
            } else {
                const cust = { id: memoryStore.customers.length + 1, user_id: userId, name, phone: cleanPhone, email: email || null, city, area, created_at: new Date().toISOString() };
                memoryStore.customers.push(cust);
                FirebaseSync.syncCustomer(cust).catch(e => console.warn('[Firebase Sync Error]:', e));
            }
            return user;
        }

        const existingSqlUser = db.prepare('SELECT * FROM users WHERE phone = ?').get(cleanPhone);
        if (existingSqlUser) {
            db.prepare('UPDATE users SET name = ?, email = ?, role = ?, password_hash = ?, city = ?, area = ? WHERE id = ?')
                .run(name || existingSqlUser.name, email || existingSqlUser.email, role || existingSqlUser.role, pHash || existingSqlUser.password_hash, city || existingSqlUser.city, area || existingSqlUser.area, existingSqlUser.id);
            return this.getUserByPhone(cleanPhone);
        }

        const stmt = db.prepare(`
            INSERT INTO users (name, phone, email, role, password_hash, city, area)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const result = stmt.run(name, cleanPhone, email || null, role, pHash, city, area);
        const userId = Number(result.lastInsertRowid);

        if (role === 'worker') {
            const existingWorker = this.getWorkerByPhone(cleanPhone);
            if (existingWorker) {
                db.prepare('UPDATE workers SET user_id = ? WHERE id = ?').run(userId, existingWorker.id);
            } else {
                const initials = name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() || 'WK';
                const workerStmt = db.prepare(`
                    INSERT INTO workers (user_id, name, phone, trade, service, initials, city, area, service_areas)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);
                const wRes = workerStmt.run(userId, name, cleanPhone, 'General Specialist', 'general', initials, city, area, `${city}, Nearby Areas`);
                const createdWorker = this.getWorkerById(Number(wRes.lastInsertRowid));
                FirebaseSync.syncWorker(createdWorker).catch(e => console.warn('[Firebase Sync Error]:', e));
            }
        } else {
            const existingCust = db.prepare('SELECT * FROM customers WHERE phone = ?').get(cleanPhone);
            if (existingCust) {
                db.prepare('UPDATE customers SET user_id = ? WHERE id = ?').run(userId, existingCust.id);
            } else {
                const custStmt = db.prepare(`
                    INSERT INTO customers (user_id, name, phone, email, city, area)
                    VALUES (?, ?, ?, ?, ?, ?)
                `);
                const cRes = custStmt.run(userId, name, cleanPhone, email || null, city, area);
                const createdCust = this.getCustomerById(Number(cRes.lastInsertRowid));
                FirebaseSync.syncCustomer(createdCust).catch(e => console.warn('[Firebase Sync Error]:', e));
            }
        }

        const createdUser = this.getUserById(userId);
        FirebaseSync.syncUser(createdUser).catch(e => console.warn('[Firebase Sync Error]:', e));
        return createdUser;
    },

    getUserByPhone(phone) {
        if (!phone) return null;
        const cleanPhone = String(phone).replace(/\D/g, '');
        if (cleanPhone.length < 10) return null;
        const last10 = cleanPhone.slice(-10);
        if (!db) {
            return memoryStore.users.find(u => u.phone === cleanPhone || u.phone === phone || (u.phone && u.phone.endsWith(last10))) || null;
        }
        const user = db.prepare("SELECT * FROM users WHERE phone = ? OR phone = ? OR REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+91', '') = ? OR phone LIKE ?").get(phone, cleanPhone, last10, `%${last10}`);
        return user || null;
    },

    getUserById(id) {
        if (!db) {
            return memoryStore.users.find(u => u.id === Number(id)) || null;
        }
        const user = db.prepare('SELECT id, name, phone, email, role, city, area, created_at FROM users WHERE id = ?').get(id);
        return user || null;
    },

    getCustomerById(id) {
        if (!db) {
            return memoryStore.customers.find(c => c.id === Number(id)) || null;
        }
        return db.prepare('SELECT * FROM customers WHERE id = ?').get(id) || null;
    },

    getCustomerByPhone(phone) {
        if (!phone) return null;
        const cleanPhone = String(phone).replace(/\D/g, '');
        if (cleanPhone.length < 10) return null;
        const last10 = cleanPhone.slice(-10);
        if (!db) {
            return memoryStore.customers.find(c => c.phone === cleanPhone || c.phone === phone || (c.phone && c.phone.endsWith(last10))) || null;
        }
        return db.prepare('SELECT * FROM customers WHERE phone = ? OR phone = ? OR phone LIKE ?').get(phone, cleanPhone, `%${last10}`) || null;
    },

    authenticateUser(phone, password) {
        let user = this.getUserByPhone(phone);
        const cleanPhone = (phone || '').replace(/\D/g, '');

        if (!user) {
            const worker = this.getWorkerByPhone(phone);
            const customer = !worker ? this.getCustomerByPhone(phone) : null;

            if (worker || customer) {
                const name = worker ? worker.name : (customer ? customer.name : 'User');
                const role = worker ? 'worker' : 'customer';
                const city = worker ? worker.city : (customer ? customer.city : 'Ramanagara');
                const area = worker ? worker.area : (customer ? customer.area : 'Town Area');
                user = this.registerUser({ name, phone: cleanPhone, password: password || '123456', role, city, area });
            }
        }

        if (!user) return null;

        // A failed login must never change the credential that is being checked.
        // The previous fallback silently replaced the stored hash with the
        // mistyped password, making both security and sign-in behaviour random.
        if (user.password_hash && password) {
            const isValid = verifyPassword(password, user.password_hash);
            if (!isValid) {
                return null;
            }
        }

        // Generate session token
        const token = crypto.randomBytes(24).toString('hex');
        if (!db) {
            memoryStore.sessions[token] = user;
            FirebaseSync.syncSession({ token, user_id: user.id, phone: user.phone, role: user.role }).catch(e => console.warn('[Firebase Sync Error]:', e));
            const extraProfile = user.role === 'worker' ? memoryStore.workers.find(w => w.user_id === user.id || w.phone === user.phone) : memoryStore.customers.find(c => c.user_id === user.id || c.phone === user.phone);
            return {
                token,
                user: {
                    id: user.id,
                    name: user.name,
                    phone: user.phone,
                    email: user.email,
                    role: user.role,
                    city: user.city,
                    area: user.area,
                    profile: extraProfile
                }
            };
        }

        db.prepare('INSERT INTO sessions (token, user_id, phone, role) VALUES (?, ?, ?, ?)').run(token, user.id, user.phone, user.role);
        FirebaseSync.syncSession({ token, user_id: user.id, phone: user.phone, role: user.role }).catch(e => console.warn('[Firebase Sync Error]:', e));

        let extraProfile = null;
        if (user.role === 'worker') {
            extraProfile = db.prepare('SELECT * FROM workers WHERE user_id = ? OR phone = ?').get(user.id, user.phone);
        } else {
            extraProfile = db.prepare('SELECT * FROM customers WHERE user_id = ? OR phone = ?').get(user.id, user.phone);
        }

        return {
            token,
            user: {
                id: user.id,
                name: user.name,
                phone: user.phone,
                email: user.email,
                role: user.role,
                city: user.city,
                area: user.area,
                profile: extraProfile
            }
        };
    },

    registerUser({ name, phone, password, role, city = 'Ramanagara', area = 'Town', email = null }) {
        return this.createUser({ name, phone, password, role, city, area, email });
    },

    updateCustomerProfile(phoneOrId, updates = {}) {
        let customer = null;
        if (typeof phoneOrId === 'number') {
            customer = this.getCustomerById(phoneOrId);
        } else {
            const clean = String(phoneOrId).replace(/\D/g, '');
            if (!db) {
                customer = memoryStore.customers.find(c => c.phone === clean);
            } else {
                customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(clean);
            }
        }
        if (!customer) return null;

        if (!db) {
            Object.assign(customer, updates);
            const user = memoryStore.users.find(u => u.phone === customer.phone || u.id === customer.user_id);
            if (user) Object.assign(user, updates);
            FirebaseSync.syncCustomer(customer).catch(e => console.warn('[Firebase Sync Error]:', e));
            return customer;
        }

        const fields = [];
        const params = [];
        if (updates.city) { fields.push('city = ?'); params.push(updates.city); }
        if (updates.area) { fields.push('area = ?'); params.push(updates.area); }
        if (updates.name) { fields.push('name = ?'); params.push(updates.name); }
        if (updates.email) { fields.push('email = ?'); params.push(updates.email); }

        if (fields.length > 0) {
            params.push(customer.id);
            db.prepare(`UPDATE customers SET ${fields.join(', ')} WHERE id = ?`).run(...params);
            // Sync name, city, and area back to users table
            const uFields = [];
            const uParams = [];
            if (updates.name) { uFields.push('name = ?'); uParams.push(updates.name); }
            if (updates.city) { uFields.push('city = ?'); uParams.push(updates.city); }
            if (updates.area) { uFields.push('area = ?'); uParams.push(updates.area); }
            if (uFields.length > 0) {
                uParams.push(customer.phone);
                db.prepare(`UPDATE users SET ${uFields.join(', ')} WHERE phone = ?`).run(...uParams);
            }
        }
        const updated = this.getCustomerById(customer.id);
        FirebaseSync.syncCustomer(updated).catch(e => console.warn('[Firebase Sync Error]:', e));
        return updated;
    },

    getSession(token) {
        if (!token) return null;
        if (!db) {
            const user = memoryStore.sessions[token];
            if (!user) return null;
            return { token, user_id: user.id, phone: user.phone, role: user.role, name: user.name, email: user.email, city: user.city, area: user.area };
        }
        const session = db.prepare(`
            SELECT s.token, s.user_id, s.phone, s.role, u.name, u.email, u.city, u.area
            FROM sessions s
            JOIN users u ON s.user_id = u.id
            WHERE s.token = ?
        `).get(token);
        return session || null;
    },

    deleteSession(token) {
        if (!token) return;
        if (!db) {
            delete memoryStore.sessions[token];
            return;
        }
        db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    },

    // ---------------- WORKER OPERATIONS ----------------
    getAllWorkers(filters = {}) {
        if (!db) {
            let workers = [...memoryStore.workers];
            if (filters.service && filters.service !== 'all') {
                const sLower = filters.service.toLowerCase();
                workers = workers.filter(w => (w.trade && w.trade.toLowerCase().includes(sLower)) || (w.service && w.service.toLowerCase().includes(sLower)));
            }
            if (filters.city && filters.city !== 'all') {
                workers = workers.filter(w => w.city && w.city.toLowerCase() === filters.city.toLowerCase());
            }
            if (filters.isAvailable !== undefined) {
                workers = workers.filter(w => Boolean(w.is_available) === Boolean(filters.isAvailable));
            }
            return workers.map(w => {
                const slots = (memoryStore.availability[w.phone] || memoryStore.availability[String(w.id)] || []);
                const latestSlot = slots.length > 0 ? slots[0] : null;
                return {
                    ...w,
                    latest_availability: latestSlot || null,
                    availability_hours: latestSlot ? `${latestSlot.start_time} – ${latestSlot.end_time} (${latestSlot.date_str})` : 'Available'
                };
            });
        }

        let query = 'SELECT * FROM workers WHERE 1=1';
        const params = [];

        if (filters.service && filters.service !== 'all') {
            // Normalize trade search keyword to root stem to match variations (e.g. Electrical -> Electric, Plumbing -> Plumb)
            let sTerm = filters.service.trim();
            const stems = {
                'Electrical': 'Electric',
                'Plumbing': 'Plumb',
                'Carpentry': 'Carpent',
                'Mechanics': 'Mechanic',
                'Home Cleaning': 'Clean',
                'Painting': 'Paint',
                'Masonry & Construction': 'Mason',
                'Tailoring & Alterations': 'Tailor',
                'Welding & Metalwork': 'Weld',
                'Driver Services': 'Driver',
                'TV & Electronics Repair': 'TV',
                'Water Purifier & RO Service': 'Water',
                'Washing Machine Repair': 'Washing',
                'Refrigerator Repair': 'Fridge',
                'AC & Appliances': 'AC'
            };
            const stem = stems[sTerm] || sTerm;

            query += ' AND (service LIKE ? OR trade LIKE ? OR service LIKE ? OR trade LIKE ?)';
            params.push(`%${sTerm}%`, `%${sTerm}%`, `%${stem}%`, `%${stem}%`);
        }
        if (filters.city && filters.city !== 'all') {
            query += ' AND city = ?';
            params.push(filters.city);
        }
        if (filters.isAvailable !== undefined) {
            query += ' AND is_available = ?';
            params.push(filters.isAvailable ? 1 : 0);
        }
        if (filters.minRating) {
            query += ' AND rating >= ?';
            params.push(Number(filters.minRating));
        }

        query += ' ORDER BY is_available DESC, rating DESC, jobs_completed DESC';
        const workers = db.prepare(query).all(...params);

        // Attach latest availability slot to each worker
        return workers.map(w => {
            const latestSlot = db.prepare(`
                SELECT date_str, start_time, end_time, is_available, updated_at
                FROM worker_availability
                WHERE worker_id = ? OR worker_phone = ?
                ORDER BY updated_at DESC, id DESC LIMIT 1
            `).get(w.id, w.phone);
            return {
                ...w,
                latest_availability: latestSlot || null,
                availability_hours: latestSlot ? `${latestSlot.start_time} – ${latestSlot.end_time} (${latestSlot.date_str})` : 'Available'
            };
        });
    },

    deleteTestWorkerByPhone(phone) {
        if (!phone) return;
        const clean = String(phone).replace(/\D/g, '');
        if (!db) {
            memoryStore.workers = memoryStore.workers.filter(w => w.phone !== clean);
            delete memoryStore.availability[clean];
            memoryStore.users = memoryStore.users.filter(u => u.phone !== clean);
            return;
        }
        const worker = this.getWorkerByPhone(clean);
        if (worker) {
            db.prepare('DELETE FROM worker_availability WHERE worker_id = ? OR worker_phone = ?').run(worker.id, clean);
            db.prepare('DELETE FROM workers WHERE id = ?').run(worker.id);
            if (worker.user_id) {
                db.prepare('DELETE FROM users WHERE id = ?').run(worker.user_id);
            }
        } else {
            db.prepare('DELETE FROM worker_availability WHERE worker_phone = ?').run(clean);
            db.prepare('DELETE FROM users WHERE phone = ?').run(clean);
        }
    },

    getWorkerById(id) {
        if (!db) return memoryStore.workers.find(w => w.id === Number(id)) || null;
        return db.prepare('SELECT * FROM workers WHERE id = ?').get(id) || null;
    },

    getWorkerByPhone(phone) {
        if (!phone) return null;
        const clean = String(phone).replace(/\D/g, '');
        if (clean.length < 10) return null;
        const last10 = clean.slice(-10);
        if (!db) {
            return memoryStore.workers.find(w => w.phone === clean || w.phone === phone || (w.phone && w.phone.endsWith(last10))) || null;
        }
        return db.prepare('SELECT * FROM workers WHERE phone = ? OR phone = ? OR phone LIKE ?').get(phone, clean, `%${last10}`) || null;
    },

    getWorkerByUserId(userId) {
        if (!db) return memoryStore.workers.find(w => w.user_id === Number(userId)) || null;
        return db.prepare('SELECT * FROM workers WHERE user_id = ?').get(userId) || null;
    },

    createWorker(data) {
        const initials = (data.name || 'WK').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
        const cleanPhone = (data.phone || '').replace(/\D/g, '');

        if (!db) {
            const existing = this.getWorkerByPhone(cleanPhone);
            if (existing) {
                return this.updateWorkerProfile(existing.id, data);
            }
            const created = {
                id: memoryStore.workers.length + 1,
                user_id: data.user_id || null,
                name: data.name || 'Worker',
                phone: cleanPhone,
                trade: data.trade || 'Skilled Specialist',
                service: (data.service || data.trade || 'general').toLowerCase(),
                skills: data.skills || '',
                tools: data.tools || 'Standard tool kit',
                rating: data.rating || 5.0,
                km: data.km || 1.5,
                jobs_completed: data.jobs_completed || 0,
                experience_years: data.experience_years || 2,
                price: data.price || 300,
                is_available: data.is_available !== undefined ? (data.is_available ? 1 : 0) : 1,
                is_verified: data.is_verified !== undefined ? (data.is_verified ? 1 : 0) : 1,
                initials,
                city: data.city || 'Ramanagara',
                area: data.area || 'Town',
                service_areas: data.service_areas || `${data.city || 'Ramanagara'}, Nearby Areas`,
                about: data.about || `${data.trade} specialist serving Karnataka`
            };
            memoryStore.workers.push(created);
            FirebaseSync.syncWorker(created).catch(e => console.warn('[Firebase Sync Error]:', e));
            return created;
        }

        try {
            const stmt = db.prepare(`
                INSERT INTO workers (user_id, name, phone, trade, service, skills, tools, rating, km, jobs_completed, experience_years, price, is_available, is_verified, initials, city, area, service_areas, about)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const res = stmt.run(
                data.user_id || null,
                data.name,
                cleanPhone,
                data.trade,
                data.service || data.trade.toLowerCase(),
                data.skills || '',
                data.tools || 'Standard tool kit',
                data.rating || 5.0,
                data.km || 1.5,
                data.jobs_completed || 0,
                data.experience_years || 2,
                data.price || 300,
                data.is_available !== undefined ? (data.is_available ? 1 : 0) : 1,
                data.is_verified !== undefined ? (data.is_verified ? 1 : 0) : 1,
                initials,
                data.city || 'Ramanagara',
                data.area || 'Town',
                data.service_areas || JSON.stringify(['Town Area', 'Market Circle', 'Bus Stand Area']),
                data.about || `${data.trade} specialist serving Karnataka`
            );

            const created = this.getWorkerById(res.lastInsertRowid);
            FirebaseSync.syncWorker(created);
            return created;
        } catch (err) {
            const existing = this.getWorkerByPhone(cleanPhone);
            if (existing) {
                return this.updateWorkerProfile(existing.id, {
                    name: data.name || existing.name,
                    trade: data.trade || existing.trade,
                    city: data.city || existing.city,
                    area: data.area || existing.area,
                    tools: data.tools || existing.tools,
                    price: data.price || existing.price
                });
            }
            throw err;
        }
    },

    registerWorkerProfile({ name, phone, trade, city = 'Ramanagara', area = 'Town', tools = 'Standard tool kit', price = 300, experienceYears = 2, skills = '', password = null }) {
        const cleanPhone = (phone || '').replace(/\D/g, '');
        if (!cleanPhone) return null;

        let existingWorker = this.getWorkerByPhone(cleanPhone);
        let existingUser = this.getUserByPhone ? this.getUserByPhone(cleanPhone) : null;
        if (existingWorker) {
            const updated = this.updateWorkerProfile(existingWorker.id, {
                name: name || existingWorker.name,
                trade: trade || existingWorker.trade,
                city: city || existingWorker.city,
                area: area || existingWorker.area,
                tools: tools || existingWorker.tools,
                price: price || existingWorker.price
            });

            if (password && existingUser) {
                const newHash = hashPassword(password);
                if (!db) {
                    existingUser.password_hash = newHash;
                } else {
                    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, existingUser.id);
                    existingUser.password_hash = newHash;
                }
            }
            if (!existingUser && this.createUser) {
                try {
                    existingUser = this.createUser({
                        name: name || existingWorker.name || 'Worker',
                        phone: cleanPhone,
                        role: 'worker',
                        password: password || 'worker@gigsync',
                        city: city || existingWorker.city || 'Ramanagara',
                        area: area || existingWorker.area || 'Town'
                    });
                } catch (_) {}
            }
            // Re-read from storage: 'persisted' must describe what is actually stored,
            // not what we hoped the UPDATE did.
            const readBack = this.getWorkerByPhone(cleanPhone);
            return {
                success: Boolean(readBack),
                persisted: Boolean(readBack)
                    && (!name || readBack.name === name)
                    && (!trade || readBack.trade === trade),
                workerId: readBack ? readBack.id : (updated ? updated.id : null),
                worker: readBack || updated,
                action: 'UPDATED',
                firebaseSync: mirrorToFirebase({ worker: readBack || updated })
            };
        }

        let userId = existingUser ? existingUser.id : null;

        if (!userId && this.createUser) {
            try {
                const u = this.createUser({
                    name: name || 'Worker',
                    phone: cleanPhone,
                    role: 'worker',
                    password: password || 'worker@gigsync',
                    city,
                    area
                });
                userId = u ? u.id : null;
            } catch (_) {}
        }

        const created = this.createWorker({
            user_id: userId,
            name: name || 'Worker',
            phone: cleanPhone,
            trade: trade || 'Skilled Specialist',
            service: (trade || 'general').toLowerCase(),
            skills: skills || trade || '',
            tools: tools || 'Standard tool kit',
            rating: 5.0,
            km: 1.5,
            jobs_completed: 0,
            experience_years: experienceYears || 2,
            price: price || 300,
            is_available: 1,
            is_verified: 1,
            city,
            area,
            about: `${experienceYears || 2}+ years experience as ${trade || 'specialist'}.`
        });

        // Verify the row exists in storage before reporting success.
        const readBack = this.getWorkerByPhone(cleanPhone);
        return {
            success: Boolean(readBack),
            persisted: Boolean(readBack),
            workerId: readBack ? readBack.id : (created ? created.id : null),
            worker: readBack || created,
            action: 'CREATED',
            firebaseSync: mirrorToFirebase({ worker: readBack || created })
        };
    },

    registerOrUpdateWorker({ name, phone, job_role, availability_date, start_time, end_time, pattern = 'once', daysOfWeek = [], rangeStart = null, rangeEnd = null, city = 'Ramanagara', password = null }) {
        const cleanPhone = (phone || '').replace(/\D/g, '');
        if (!cleanPhone || cleanPhone.length !== 10) {
            return { success: false, persisted: false, error: 'A valid 10-digit phone number is required.' };
        }

        const trade = job_role || 'Skilled Specialist';
        let worker = this.getWorkerByPhone(cleanPhone);
        if (worker) {
            // Reuse the profile upsert so a password supplied by voice
            // onboarding is persisted for an already-existing worker too.
            this.registerWorkerProfile({
                name: name || worker.name,
                phone: cleanPhone,
                trade: trade,
                city: city || worker.city || 'Ramanagara',
                password
            });
        } else {
            this.registerWorkerProfile({
                name: name || 'Worker',
                phone: cleanPhone,
                trade: trade,
                city: city || 'Ramanagara',
                password
            });
        }

        const updatedWorker = this.getWorkerByPhone(cleanPhone);
        let availabilityResult = null;
        if (updatedWorker && availability_date && start_time && end_time) {
            availabilityResult = this.setWorkerAvailabilitySlot({
                workerId: updatedWorker.id,
                workerPhone: cleanPhone,
                trade: updatedWorker.trade,
                dateStr: availability_date,
                startTime: start_time,
                endTime: end_time,
                isAvailable: true,
                pattern,
                daysOfWeek,
                rangeStart: rangeStart || availability_date,
                rangeEnd
            });
        }

        const persisted = Boolean(updatedWorker && updatedWorker.id);
        return {
            success: persisted,
            persisted,
            worker: updatedWorker,
            availability: availabilityResult
        };
    },

    updateWorkerProfile(id, updates = {}) {
        if (!db) {
            const worker = memoryStore.workers.find(w => w.id === Number(id));
            if (!worker) return null;
            Object.assign(worker, updates);
            if (updates.trade) worker.service = updates.trade.toLowerCase();
            if (updates.name) {
                const user = memoryStore.users.find(u => u.phone === worker.phone || u.id === worker.user_id);
                if (user) user.name = updates.name;
            }
            FirebaseSync.syncWorker(worker).catch(e => console.warn('[Firebase Sync Error]:', e));
            emitChange('worker', { workerId: worker.id, workerPhone: worker.phone, workerName: worker.name, city: worker.city });
            return worker;
        }

        const fields = [];
        const params = [];

        if (updates.name) { fields.push('name = ?'); params.push(updates.name); }
        if (updates.trade) { fields.push('trade = ?', 'service = ?'); params.push(updates.trade, updates.trade.toLowerCase()); }
        if (updates.skills !== undefined) { fields.push('skills = ?'); params.push(updates.skills); }
        if (updates.tools !== undefined) { fields.push('tools = ?'); params.push(updates.tools); }
        if (updates.price !== undefined) { fields.push('price = ?'); params.push(Number(updates.price)); }
        if (updates.city !== undefined) { fields.push('city = ?'); params.push(updates.city); }
        if (updates.area !== undefined) { fields.push('area = ?'); params.push(updates.area); }
        if (updates.service_areas !== undefined) { fields.push('service_areas = ?'); params.push(updates.service_areas); }
        if (updates.about !== undefined) { fields.push('about = ?'); params.push(updates.about); }
        if (updates.is_available !== undefined) { fields.push('is_available = ?'); params.push(updates.is_available ? 1 : 0); }

        if (fields.length === 0) return this.getWorkerById(id);

        params.push(id);
        db.prepare(`UPDATE workers SET ${fields.join(', ')} WHERE id = ?`).run(...params);
        const updated = this.getWorkerById(id);
        
        // Sync name changes to users table
        if (updates.name && updated) {
            db.prepare('UPDATE users SET name = ? WHERE phone = ? OR id = ?').run(updates.name, updated.phone, updated.user_id || -1);
        }

        FirebaseSync.syncWorker(updated).catch(e => console.warn('[Firebase Sync Error]:', e));
        if (updated) emitChange('worker', { workerId: updated.id, workerPhone: updated.phone, workerName: updated.name, city: updated.city });
        return updated;
    },

    updateWorkerAvailabilityStatus(workerIdOrPhone, isAvailable) {
        let worker = null;
        if (typeof workerIdOrPhone === 'string' && workerIdOrPhone.length >= 10) {
            worker = this.getWorkerByPhone(workerIdOrPhone);
        } else if (typeof workerIdOrPhone === 'number') {
            worker = this.getWorkerById(workerIdOrPhone);
        } else if (!isNaN(Number(workerIdOrPhone)) && String(workerIdOrPhone).length < 10) {
            worker = this.getWorkerById(Number(workerIdOrPhone));
        } else {
            worker = this.getWorkerByPhone(workerIdOrPhone);
        }

        if (!worker) return null;
        if (!db) {
            worker.is_available = isAvailable ? 1 : 0;
            FirebaseSync.syncWorker(worker).catch(e => console.warn('[Firebase Sync Error]:', e));
            emitChange('worker', { workerId: worker.id, workerPhone: worker.phone, workerName: worker.name, isAvailable: Boolean(isAvailable) });
            return worker;
        }
        db.prepare('UPDATE workers SET is_available = ? WHERE id = ?').run(isAvailable ? 1 : 0, worker.id);
        const updated = this.getWorkerById(worker.id);
        FirebaseSync.syncWorker(updated).catch(e => console.warn('[Firebase Sync Error]:', e));
        emitChange('worker', { workerId: updated.id, workerPhone: updated.phone, workerName: updated.name, isAvailable: Boolean(updated.is_available) });
        return updated;
    },

    // ---------------- SCHEDULE & CONFLICT CHECK ----------------
    setWorkerAvailabilitySlot({ workerId, workerPhone, trade, dateStr, startTime, endTime, isAvailable = true, notes = '',
                                  pattern = 'once', daysOfWeek = [], rangeStart = null, rangeEnd = null } = {}, options = {}) {
        dateStr = normalizeDateKey(dateStr);
        rangeStart = normalizeDateKey(rangeStart || dateStr);
        rangeEnd = rangeEnd ? normalizeDateKey(rangeEnd) : null;
        // Merge top-level fields into options so the SQLite branch can read them uniformly
        options = { pattern, daysOfWeek, rangeStart: rangeStart || dateStr, rangeEnd, ...options };

        let worker = null;
        if (workerId) worker = this.getWorkerById(workerId);
        else if (workerPhone) worker = this.getWorkerByPhone(workerPhone);

        const phone = worker ? worker.phone : (workerPhone || '').replace(/\D/g, '');
        const wTrade = worker ? worker.trade : trade || 'Skilled Specialist';
        const wId = worker ? worker.id : null;

        if (!db) {
            if (!memoryStore.availability[phone]) memoryStore.availability[phone] = [];
            // Upsert by (worker, date) so "change my hours for tomorrow" replaces the slot
            // instead of stacking a second, contradictory row for the same day.
            const existingIdx = memoryStore.availability[phone].findIndex(s => {
                const slotPattern = String(s.pattern || 'once').toLowerCase();
                if (slotPattern !== String(options.pattern || 'once').toLowerCase()) return false;
                if (_pat === 'once') return String(s.date_str).toLowerCase() === String(dateStr).toLowerCase();
                if (_pat === 'daily') return true;
                if (_pat === 'weekly') return normalizeDaysOfWeekKey(JSON.parse(s.days_of_week || '[]')) === _dow;
                return String(s.date_str).toLowerCase() === String(dateStr).toLowerCase();
            });
            const slot = {
                id: existingIdx >= 0 ? memoryStore.availability[phone][existingIdx].id : Date.now(),
                worker_id: wId,
                worker_phone: phone,
                trade: wTrade,
                date_str: dateStr,
                start_time: startTime,
                end_time: endTime,
                is_available: isAvailable ? 1 : 0,
                notes,
                pattern: options.pattern || 'once',
                days_of_week: JSON.stringify(options.daysOfWeek || []),
                range_start: options.rangeStart || dateStr,
                range_end: options.rangeEnd || null,
                updated_at: new Date().toISOString()
            };
            if (existingIdx >= 0) memoryStore.availability[phone][existingIdx] = slot;
            else memoryStore.availability[phone].unshift(slot);
            if (worker) worker.is_available = isAvailable ? 1 : 0;
            emitChange('availability', {
                workerId: wId,
                workerPhone: phone,
                workerName: worker ? worker.name : null,
                date: dateStr,
                startTime,
                endTime,
                isAvailable: Boolean(isAvailable)
            });
            return {
                success: true,
                persisted: true,
                slotId: slot.id,
                workerId: wId,
                workerPhone: phone,
                workerName: worker ? worker.name : null,
                trade: wTrade,
                date: dateStr,
                startTime,
                endTime,
                hours: `${startTime} – ${endTime}`,
                isAvailable: Boolean(isAvailable),
                firebaseSync: mirrorToFirebase({ worker, slot })
            };
        }

        // Upsert on schedule identity so edits replace the latest version instead of
        // stacking duplicates for the same worker.
        const _pat = options.pattern || 'once';
        const _dow = normalizeDaysOfWeekKey(options.daysOfWeek || []);
        const _rs  = options.rangeStart || dateStr;
        const _re  = options.rangeEnd || null;

        let existingSlot = null;
        if (_pat === 'once') {
            existingSlot = db.prepare(
                `SELECT * FROM worker_availability WHERE worker_phone = ? AND LOWER(date_str) = LOWER(?) AND pattern = 'once' ORDER BY id DESC LIMIT 1`
            ).get(phone, dateStr);
        } else if (_pat === 'daily') {
            existingSlot = db.prepare(
                `SELECT * FROM worker_availability WHERE worker_phone = ? AND pattern = 'daily' ORDER BY id DESC LIMIT 1`
            ).get(phone);
        } else if (_pat === 'weekly') {
            existingSlot = db.prepare(
                `SELECT * FROM worker_availability WHERE worker_phone = ? AND pattern = 'weekly' AND days_of_week = ? ORDER BY id DESC LIMIT 1`
            ).get(phone, _dow);
        }

        let slotId;
        if (existingSlot) {
            db.prepare(`
                UPDATE worker_availability
                SET worker_id = ?, trade = ?, date_str = ?, start_time = ?, end_time = ?, is_available = ?, notes = ?,
                    pattern = ?, days_of_week = ?, range_start = ?, range_end = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(wId, wTrade, dateStr, startTime, endTime, isAvailable ? 1 : 0, notes,
                   _pat, _dow, _rs, _re, existingSlot.id);
            slotId = existingSlot.id;
            if (_pat === 'once') {
                db.prepare(
                    `DELETE FROM worker_availability WHERE worker_phone = ? AND pattern = 'once' AND LOWER(date_str) = LOWER(?) AND id <> ?`
                ).run(phone, dateStr, existingSlot.id);
            } else if (_pat === 'daily') {
                db.prepare(
                    `DELETE FROM worker_availability WHERE worker_phone = ? AND pattern = 'daily' AND id <> ?`
                ).run(phone, existingSlot.id);
            } else if (_pat === 'weekly') {
                db.prepare(
                    `DELETE FROM worker_availability WHERE worker_phone = ? AND pattern = 'weekly' AND days_of_week = ? AND id <> ?`
                ).run(phone, _dow, existingSlot.id);
            }
        } else {
            const runRes = db.prepare(`
                INSERT INTO worker_availability
                    (worker_id, worker_phone, trade, date_str, start_time, end_time, is_available, notes,
                     pattern, days_of_week, range_start, range_end)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(wId, phone, wTrade, dateStr, startTime, endTime, isAvailable ? 1 : 0, notes,
                   _pat, _dow, _rs, _re);
            slotId = Number(runRes.lastInsertRowid);
        }

        // Read back what SQLite actually stored — this, not the input, is the truth.
        const slot = db.prepare('SELECT * FROM worker_availability WHERE id = ?').get(slotId);
        const updatedWorker = wId ? this.getWorkerById(wId) : null;
        const updatedIsAvailable = slot ? Boolean(slot.is_available) : Boolean(isAvailable);
        if (wId) {
            db.prepare('UPDATE workers SET is_available = ? WHERE id = ?').run(updatedIsAvailable ? 1 : 0, wId);
        }

        // Tell open pages. Announced from the read-back row, so a listener can never be
        // told about hours that were not actually stored.
        if (slot) {
            emitChange('availability', {
                workerId: wId,
                workerPhone: phone,
                workerName: worker ? worker.name : null,
                date: slot.date_str,
                startTime: slot.start_time,
                endTime: slot.end_time,
            isAvailable: Boolean(slot.is_available)
        });
        }

        return {
            success: Boolean(slot),
            persisted: Boolean(slot) && slot.start_time === startTime && slot.end_time === endTime,
            slotId,
            workerId: wId,
            workerPhone: phone,
            workerName: worker ? worker.name : null,
            trade: wTrade,
            date: slot ? slot.date_str : dateStr,
            startTime: slot ? slot.start_time : startTime,
            endTime: slot ? slot.end_time : endTime,
            hours: `${slot ? slot.start_time : startTime} – ${slot ? slot.end_time : endTime}`,
            isAvailable: Boolean(isAvailable),
            // Promise the caller can await to learn the REAL Firestore outcome, instead of a
            // fire-and-forget call whose 403 nobody ever saw.
            firebaseSync: mirrorToFirebase({ worker: updatedWorker, slot })
        };
    },

    getWorkerSchedule(workerIdOrPhone) {
        let worker = null;
        if (typeof workerIdOrPhone === 'string' && workerIdOrPhone.length >= 10) {
            worker = this.getWorkerByPhone(workerIdOrPhone);
        } else if (typeof workerIdOrPhone === 'number') {
            worker = this.getWorkerById(workerIdOrPhone);
        } else if (!isNaN(Number(workerIdOrPhone)) && String(workerIdOrPhone).length < 10) {
            worker = this.getWorkerById(Number(workerIdOrPhone));
        } else {
            worker = this.getWorkerByPhone(workerIdOrPhone);
        }

        const phone = worker ? worker.phone : String(workerIdOrPhone).replace(/\D/g, '');
        const wId = worker ? worker.id : null;

        if (!db) {
            const slots = memoryStore.availability[phone] || [];
            const activeBookings = memoryStore.jobs.filter(j => (normalizePhone(j.worker_phone) === normalizePhone(phone) || (wId && Number(j.worker_id) === Number(wId))) && ['Requested', 'Confirmed', 'Assigned', 'Accepted', 'On the Way', 'In Progress'].includes(j.status));
            return {
                worker,
                isAvailableNow: worker ? Boolean(worker.is_available) : true,
                availabilitySlots: slots,
                activeBookings
            };
        }

        const availabilitySlots = db.prepare(`
            SELECT * FROM worker_availability
            WHERE worker_phone = ? OR (worker_id IS NOT NULL AND worker_id = ?)
            ORDER BY updated_at DESC, id DESC LIMIT 10
        `).all(phone, wId || -1);

        const activeBookings = db.prepare(`
            SELECT id, service, problem_description, location, requested_date, requested_time, status, customer_name, budget
            FROM jobs
            WHERE (worker_id = ? OR worker_phone = ?) AND status IN ('Requested', 'Confirmed', 'Assigned', 'Accepted', 'On the Way', 'In Progress')
            ORDER BY created_at ASC
        `).all(wId || -1, phone);

        return {
            worker,
            isAvailableNow: worker ? Boolean(worker.is_available) : true,
            availabilitySlots,
            activeBookings
        };
    },

    getWorkerAvailability(workerIdOrPhone, dateStr = null) {
        const schedule = this.getWorkerSchedule(workerIdOrPhone);
        const slots = schedule ? schedule.availabilitySlots : [];
        if (!dateStr) return slots;
        const wanted = normalizeDateKey(dateStr);
        return slots.filter(s => {
            if (!s || !s.date_str) return false;
            if (normalizeDateKey(s.date_str).toLowerCase() === wanted.toLowerCase()) return true;
            return this.expandAvailabilityPattern(s, wanted, wanted).includes(wanted);
        });
    },

    /* -----------------------------------------------------------------------
       PATTERN EXPANSION & DATE-BASED AVAILABILITY
       ----------------------------------------------------------------------- */

    /**
     * Expands a single availability row (which may be a pattern) into every
     * concrete ISO date string it covers within [fromDate, toDate].
     * Both dates are JS Date objects or ISO strings.
     */
    expandAvailabilityPattern(slot, fromDate, toDate) {
        const from = parseDateOnly(fromDate);
        const to   = parseDateOnly(toDate);
        const dates = [];

        if (!slot || !slot.start_time || !slot.end_time) return dates;

        const pat = slot.pattern || 'once';

        if (pat === 'once') {
            // Single concrete date — just check it falls in the window
            const d = parseDateOnly(slot.date_str);
            if (!isNaN(d) && d >= from && d <= to) dates.push(slot.date_str);
            return dates;
        }

        // Build an iteration range bounded by [rangeStart, rangeEnd ∩ toDate]
        const rangeStart = parseDateOnly(slot.range_start || slot.date_str);
        const rangeEnd   = slot.range_end ? parseDateOnly(slot.range_end) : to;
        const itStart    = rangeStart > from ? rangeStart : from;
        const itEnd      = rangeEnd < to     ? rangeEnd   : to;

        // Parse days_of_week — stored as JSON array of day numbers (0=Sun … 6=Sat)
        let dow = [];
        try { dow = JSON.parse(slot.days_of_week || '[]'); } catch (_) {}

        const cur = new Date(itStart);
        while (cur <= itEnd) {
            const curDay = cur.getDay(); // 0=Sun
            if (pat === 'daily' || (pat === 'weekly' && dow.includes(curDay))) {
                const y = cur.getFullYear();
                const m = String(cur.getMonth() + 1).padStart(2, '0');
                const d2 = String(cur.getDate()).padStart(2, '0');
                dates.push(`${y}-${m}-${d2}`);
            }
            cur.setDate(cur.getDate() + 1);
        }
        return dates;
    },

    /**
     * Returns all workers who have availability covering the given ISO date
     * in the given city.  Used by the customer calendar booking flow.
     */
    getWorkersAvailableOnDate(dateStr, city = null, requestedTime = null, requestedEndTime = null) {
        dateStr = normalizeDateKey(dateStr);
        const from = parseDateOnly(dateStr);
        const to   = parseDateOnly(dateStr);

        if (!db) {
            const results = [];
            for (const w of memoryStore.workers) {
                if (city && w.city !== city) continue;
                if (!w.is_available) continue;
                const slots = memoryStore.availability[w.phone] || [];
                const covers = slots.some(s => {
                    if (!s.is_available) return false;
                    return this.expandAvailabilityPattern(s, from, to).includes(dateStr);
                });
                if (covers) results.push(w);
            }
            if (requestedTime) {
                return results.filter(w => this.checkScheduleConflict(w.id, dateStr, requestedTime, requestedEndTime) === null);
            }
            return results;
        }

        const allSlots = db.prepare(`
            SELECT wa.*, w.name AS worker_name, w.trade, w.price, w.rating, w.city,
                   w.phone AS worker_phone_col, w.id AS worker_id_col, w.is_verified
            FROM worker_availability wa
            JOIN workers w ON wa.worker_id = w.id
            WHERE wa.is_available = 1
              AND w.is_available = 1
              ${city ? 'AND w.city = ?' : ''}
            ORDER BY wa.updated_at DESC
        `).all(...(city ? [city] : []));

        const workerIds = new Set();
        const results   = [];

        for (const s of allSlots) {
            if (workerIds.has(s.worker_id)) continue;
            const covered = this.expandAvailabilityPattern(s, from, to);
            if (covered.includes(dateStr)) {
                workerIds.add(s.worker_id);
                results.push({
                    id:           s.worker_id_col,
                    name:         s.worker_name,
                    phone:        s.worker_phone_col,
                    trade:        s.trade,
                    price:        s.price,
                    rating:       s.rating,
                    city:         s.city,
                    is_verified:  s.is_verified,
                    start_time:   s.start_time,
                    end_time:     s.end_time,
                    availability_hours: `${s.start_time} – ${s.end_time}`
                });
            }
        }
        if (requestedTime) {
            return results.filter(w => this.checkScheduleConflict(w.id, dateStr, requestedTime, requestedEndTime) === null);
        }
        return results;
    },

    /**
     * Given a worker and a proposed new set of availability slots, return all
     * currently confirmed/accepted jobs that are no longer covered by the new
     * pattern.  Caller uses this to show the conflict modal.
     *
     * proposedSlots: array of { pattern, daysOfWeek, rangeStart, rangeEnd, startTime, endTime }
     * lookAheadDays: how far into the future to check (default 90)
     */
    getConflictingJobsForAvailabilityChange(workerId, proposedSlots = [], lookAheadDays = 90) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const cutoff = new Date(today);
        cutoff.setDate(cutoff.getDate() + lookAheadDays);

        // Build the set of all dates covered by the NEW availability pattern
        const coveredDates = new Set();
        for (const ps of proposedSlots) {
            const syntheticSlot = {
                pattern:      ps.pattern || 'once',
                days_of_week: JSON.stringify(ps.daysOfWeek || []),
                range_start:  ps.rangeStart,
                range_end:    ps.rangeEnd || null,
                date_str:     ps.rangeStart,
                start_time:   ps.startTime,
                end_time:     ps.endTime,
                is_available: 1
            };
            const dates = this.expandAvailabilityPattern(syntheticSlot, today, cutoff);
            dates.forEach(d => coveredDates.add(d));
        }

        // Find upcoming booked jobs for this worker whose date is NOT covered
        let bookedJobs = [];
        if (!db) {
            bookedJobs = memoryStore.jobs.filter(j =>
                j.worker_id === Number(workerId) &&
                ['Confirmed', 'Accepted', 'On the Way'].includes(j.status)
            );
        } else {
            bookedJobs = db.prepare(`
                SELECT * FROM jobs
                WHERE worker_id = ?
                  AND status IN ('Confirmed', 'Accepted', 'On the Way')
                ORDER BY requested_date ASC
            `).all(Number(workerId));
        }

        return bookedJobs.filter(j => {
            // Only flag future jobs
            const jDate = parseDateOnly(j.requested_date);
            if (isNaN(jDate) || jDate < today) return false;
            // Flag if the job date is NOT in the new covered set
            return !coveredDates.has(j.requested_date);
        });
    },

    /**
     * Worker resolves one conflicting job:
     *   canWork = true  → job stays Confirmed (no action needed)
     *   canWork = false → job is cancelled (from worker's side), cleared of worker,
     *                     reposted as Requested for other workers, and customer is notified
     *                     via the live change stream.
     */
    resolveAvailabilityConflict(jobId, canWork) {
        if (canWork) return { jobId, action: 'kept' };

        const job = this.getJobById(jobId);
        if (!job) return { jobId, action: 'not_found' };

        if (!db) {
            job.status       = 'Cancelled (Worker)';
            job.worker_id    = null;
            job.worker_phone = null;
            job.worker_name  = 'Reposted — finding new specialist';
            emitChange('job', { jobId: job.id, status: job.status, customerPhone: job.customer_phone, workerId: null });
            FirebaseSync.syncJob(job).catch(() => {});
            return { jobId, action: 'cancelled_and_reposted', job };
        }

        db.prepare(`
            UPDATE jobs
            SET status = 'Requested',
                worker_id = NULL,
                worker_phone = NULL,
                worker_name = 'Reposted — finding new specialist'
            WHERE id = ?
        `).run(jobId);

        const updated = this.getJobById(jobId);
        emitChange('job', { jobId, status: 'Requested', customerPhone: job.customer_phone, workerId: null });
        FirebaseSync.syncJob(updated).catch(() => {});
        return { jobId, action: 'cancelled_and_reposted', job: updated };
    },

    workerCancelJob(jobId, workerId, workerName = null, workerPhone = null) {
        const job = this.getJobById(jobId);
        if (!job || !workerId) return { ok: false, message: 'Job not found.' };

        this.recordWorkerJobAction(workerId, jobId, 'cancelled');

        const ownsJob = Number(job.worker_id) === Number(workerId)
            || (workerPhone && normalizePhone(job.worker_phone) === normalizePhone(workerPhone));

        if (!ownsJob) {
            return { ok: true, job, action: 'hidden_only' };
        }

        if (!db) {
            job.status = 'Requested';
            job.worker_id = null;
            job.worker_phone = null;
            job.worker_name = 'Broadcasting to nearby verified specialists...';
            emitChange('job', { jobId: job.id, status: job.status, customerPhone: job.customer_phone, workerId: null });
            FirebaseSync.syncJob(job).catch(() => {});
            return { ok: true, job, action: 'reposted' };
        }

        db.prepare(`
            UPDATE jobs
            SET status = 'Requested',
                worker_id = NULL,
                worker_phone = NULL,
                worker_name = 'Broadcasting to nearby verified specialists...'
            WHERE id = ?
        `).run(jobId);

        const updated = this.getJobById(jobId);
        emitChange('job', { jobId: job.id, status: 'Requested', customerPhone: job.customer_phone, workerId: null });
        FirebaseSync.syncJob(updated).catch(() => {});
        return { ok: true, job: updated, action: 'reposted' };
    },

    
    checkScheduleConflict(workerId, requestedDate, requestedTime, requestedEndTime = null) {
        // Helper to parse time to minutes from midnight.
        // If a range string is passed (e.g. "09:00 AM – 05:00 PM"), only the START
        // portion is used. This prevents the parser from silently returning 0
        // (midnight) when a range is forwarded instead of a point-in-time.
        function parseTimeToMinutes(timeStr) {
            if (!timeStr) return 0;
            // Strip anything after the first dash / en-dash / em-dash so a range
            // string like "09:00 AM – 05:00 PM" or "11 AM to 12 PM" is treated
            // as the start time only.
            let clean = String(timeStr).split(/\s+(?:to|till|until)\s+|[-\u2013\u2014]/i)[0].trim().toUpperCase();
            const isAm = clean.includes('AM');
            const isPm = clean.includes('PM');
            clean = clean.replace(/(AM|PM)/, '').trim();
            const parts = clean.split(':');
            let hours = parseInt(parts[0], 10) || 0;
            const minutes = parseInt(parts[1], 10) || 0;
            if (isPm && hours < 12) hours += 12;
            if (isAm && hours === 12) hours = 0;
            return hours * 60 + minutes;
        }
        function parseEndMinutes(timeStr, explicitEndTime = null) {
            if (explicitEndTime) return parseTimeToMinutes(explicitEndTime);
            if (!timeStr) return parseTimeToMinutes(timeStr);
            const parts = String(timeStr).split(/\s+(?:to|till|until)\s+/i);
            // A point booking occupies the standard one-hour slot used by the
            // existing booking UI and regression tests.
            return parts.length > 1 ? parseTimeToMinutes(parts[1]) : parseTimeToMinutes(timeStr) + 60;
        }

        const reqMin = parseTimeToMinutes(requestedTime);
        const reqEnd = parseEndMinutes(requestedTime, requestedEndTime);
        const reqDateStr = normalizeDateKey(requestedDate);
        if (reqMin === null || reqEnd === null) return null;
        if (reqEnd <= reqMin) return 'OutsideHours';

        if (!db) {
            const existingJobConflict = memoryStore.jobs.find(j => {
                if (j.worker_id !== Number(workerId) || normalizeDateKey(j.requested_date).toLowerCase() !== reqDateStr.toLowerCase()) return false;
                if (!['Requested', 'Confirmed', 'Assigned', 'Accepted', 'On the Way', 'In Progress'].includes(j.status)) return false;
                const jMin = parseTimeToMinutes(j.requested_time);
                const jEnd = parseEndMinutes(j.requested_time, j.requested_end_time);
                return jMin < reqEnd && reqMin < jEnd;
            });
            if (existingJobConflict) return 'JobConflict';

            // 1. Check availability slot
            const phone = memoryStore.workers.find(w => w.id === Number(workerId))?.phone || String(workerId).replace(/\D/g, '');
            const slots = (phone && memoryStore.availability[phone]) ? memoryStore.availability[phone].filter(s => s.is_available === 1) : [];

            const matchingSlots = [];
            for (const s of slots) {
                if (normalizeDateKey(s.date_str).toLowerCase() === reqDateStr.toLowerCase()) {
                    matchingSlots.push(s);
                    continue;
                }
                const covered = this.expandAvailabilityPattern(s, reqDateStr, reqDateStr);
                if (covered.includes(reqDateStr)) {
                    matchingSlots.push(s);
                }
            }

            if (!matchingSlots.length) return 'NotAvailable';
            if (!matchingSlots.some(s => reqMin >= parseTimeToMinutes(s.start_time) && reqEnd <= parseTimeToMinutes(s.end_time))) return 'OutsideHours';

            // 2. Check conflicting jobs
            const conflict = memoryStore.jobs.find(j => {
                if (j.worker_id !== Number(workerId) || normalizeDateKey(j.requested_date).toLowerCase() !== reqDateStr.toLowerCase()) return false;
                if (!['Requested', 'Confirmed', 'Assigned', 'Accepted', 'On the Way', 'In Progress'].includes(j.status)) return false;
                const jMin = parseTimeToMinutes(j.requested_time);
                const jEnd = parseEndMinutes(j.requested_time, j.requested_end_time);
                return jMin < reqEnd && reqMin < jEnd;
            });
            if (conflict) return 'JobConflict';
            return null;
        }

        // SQLite Implementation
        // 1. Fetch all active availability records for this worker
        const workerRow = db.prepare('SELECT phone FROM workers WHERE id = ?').get(Number(workerId));
        const wPhone = workerRow && workerRow.phone ? String(workerRow.phone).replace(/\D/g, '') : String(workerId).replace(/\D/g, '');

        const existingConflict = db.prepare(`
            SELECT requested_date, requested_time, requested_end_time FROM jobs
            WHERE (worker_id = ? OR worker_phone = ?)
              AND status IN ('Requested', 'Confirmed', 'Assigned', 'Accepted', 'On the Way', 'In Progress')
        `).all(Number(workerId), wPhone).find(j => {
            if (normalizeDateKey(j.requested_date).toLowerCase() !== reqDateStr.toLowerCase()) return false;
            const jMin = parseTimeToMinutes(j.requested_time);
            const jEnd = parseEndMinutes(j.requested_time, j.requested_end_time);
            return jMin < reqEnd && reqMin < jEnd;
        });
        if (existingConflict) return 'JobConflict';

        const allSlots = db.prepare(`
            SELECT * FROM worker_availability
            WHERE (worker_id = ? OR worker_phone = ?)
              AND is_available = 1
            ORDER BY updated_at DESC, id DESC
        `).all(Number(workerId), wPhone);

        const matchingSlots = [];
        for (const s of allSlots) {
            if (s.date_str && normalizeDateKey(s.date_str).toLowerCase() === reqDateStr.toLowerCase()) {
                matchingSlots.push(s);
                continue;
            }
            const covered = this.expandAvailabilityPattern(s, reqDateStr, reqDateStr);
            if (covered.includes(reqDateStr)) {
                matchingSlots.push(s);
            }
        }

        if (!matchingSlots.length) return 'NotAvailable';
        if (!matchingSlots.some(s => reqMin >= parseTimeToMinutes(s.start_time) && reqEnd <= parseTimeToMinutes(s.end_time))) return 'OutsideHours';

        // 2. Check conflicting jobs
        // Older rows may contain labels such as "Tomorrow" while newer rows
        // use ISO dates. Read both and normalize in JavaScript so conflict
        // detection and the worker booking list always use the same identity.
        const jobs = db.prepare(`
            SELECT requested_date, requested_time, requested_end_time FROM jobs
            WHERE (worker_id = ? OR worker_phone = ?)
              AND status IN ('Requested', 'Confirmed', 'Assigned', 'Accepted', 'On the Way', 'In Progress')
        `).all(Number(workerId), wPhone).filter(j => normalizeDateKey(j.requested_date).toLowerCase() === reqDateStr.toLowerCase());

        for (const j of jobs) {
            const jMin = parseTimeToMinutes(j.requested_time);
            const jEnd = parseEndMinutes(j.requested_time, j.requested_end_time);
            if (jMin < reqEnd && reqMin < jEnd) {
                return 'JobConflict';
            }
        }

        return null;
    },

    // ---------------- JOB & BOOKING OPERATIONS ----------------
    createJob(jobData) {
        jobData = { ...jobData, requested_date: normalizeDateKey(jobData.requested_date || 'Today') };
        if (!jobData.service || !String(jobData.service).trim()) throw new Error('Service is required.');
        if (!jobData.problem_description || !String(jobData.problem_description).trim()) throw new Error('Problem description is required.');

        let jobId = jobData.id || generateJobId();
        while (this.getJobById(jobId)) jobId = generateJobId();
        const priceNum = parseInt(String(jobData.budget || '350').replace(/\D/g, ''), 10) || 350;
        const cleanCustomerPhone = normalizePhone(jobData.customer_phone);
        if (cleanCustomerPhone.length !== 10) throw new Error('A valid 10-digit customer phone number is required.');

        // Resolve the worker once, then store one consistent ID/phone/name tuple.
        // Previously an invalid worker_id could be silently paired with a valid
        // worker_phone (or vice versa), producing a booking that neither portal
        // could reliably find.
        let assignedWorker = null;
        if (jobData.worker_id !== null && jobData.worker_id !== undefined && String(jobData.worker_id) !== '') {
            assignedWorker = this.getWorkerById(Number(jobData.worker_id));
            if (!assignedWorker) throw new Error('Selected worker was not found.');
        } else if (jobData.worker_phone) {
            assignedWorker = this.getWorkerByPhone(jobData.worker_phone);
            if (!assignedWorker) throw new Error('Selected worker was not found.');
        }

        const cleanWorkerPhone = assignedWorker ? normalizePhone(assignedWorker.phone) : null;
        const validWorkerId = assignedWorker ? assignedWorker.id : null;
        const requestedStatus = String(jobData.status || '').trim();
        const status = VALID_JOB_STATUSES.has(requestedStatus)
            ? requestedStatus
            : (validWorkerId ? 'Confirmed' : 'Requested');
        const storedStatus = validWorkerId
            ? (['Confirmed', 'Assigned', 'Accepted', 'On the Way', 'In Progress'].includes(status) ? status : 'Confirmed')
            : 'Requested';

        if (!db) {
            const job = {
                id: jobId,
                customer_id: jobData.customer_id || null,
                customer_phone: cleanCustomerPhone,
                customer_name: jobData.customer_name || 'Customer',
                worker_id: validWorkerId,
                worker_phone: cleanWorkerPhone,
                worker_name: assignedWorker ? assignedWorker.name : (jobData.worker_name || 'Finding nearby specialists...'),
                service: jobData.service || 'Specialist Visit',
                problem_description: jobData.problem_description || '',
                location: jobData.location || 'Town Area',
                city: jobData.city || 'Ramanagara',
                requested_date: jobData.requested_date || 'Today',
                requested_time: jobData.requested_time || 'Immediate',
                requested_end_time: jobData.requested_end_time || null,
                budget: jobData.budget || `₹${priceNum}`,
                final_price: priceNum,
                status: storedStatus,
                payment_status: 'Pending',
                payment_method: jobData.payment_method || 'Cash',
                created_at: new Date().toISOString()
            };
            memoryStore.jobs.unshift(job);
            FirebaseSync.syncJob(job).catch(e => console.warn('[Firebase Sync Error]:', e));
            return job;
        }

        let validCustomerId = null;
        if (jobData.customer_id) {
            try {
                const custRow = db.prepare('SELECT id FROM customers WHERE id = ? OR user_id = ?').get(jobData.customer_id, jobData.customer_id);
                if (custRow) validCustomerId = custRow.id;
                else {
                    const uRow = db.prepare('SELECT id FROM users WHERE id = ?').get(jobData.customer_id);
                    if (uRow) validCustomerId = uRow.id;
                }
            } catch(e){}
        }
        if (!validCustomerId && cleanCustomerPhone) {
            try {
                const custRow = db.prepare('SELECT id FROM customers WHERE phone = ?').get(cleanCustomerPhone);
                if (custRow) validCustomerId = custRow.id;
                else {
                    const uRow = db.prepare('SELECT id FROM users WHERE phone = ?').get(cleanCustomerPhone);
                    if (uRow) validCustomerId = uRow.id;
                }
            } catch(e){}
        }

        const stmt = db.prepare(`
            INSERT INTO jobs (
                id, customer_id, customer_phone, customer_name,
                worker_id, worker_phone, worker_name,
                service, problem_description, location, city,
                requested_date, requested_time, requested_end_time, budget, final_price,
                status, payment_status, payment_method
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
            jobId,
            validCustomerId,
            cleanCustomerPhone,
            jobData.customer_name || 'Customer',
            validWorkerId,
            cleanWorkerPhone,
            assignedWorker ? assignedWorker.name : (jobData.worker_name || 'Finding nearby specialists...'),
            jobData.service || 'General Service',
            jobData.problem_description || '',
            jobData.location || 'Town Area',
            jobData.city || 'Ramanagara',
            jobData.requested_date || 'Today',
            jobData.requested_time || 'Immediate',
            jobData.requested_end_time || null,
            jobData.budget || `₹${priceNum}`,
            priceNum,
            storedStatus,
            'Pending',
            jobData.payment_method || 'Cash'
        );

        const created = this.getJobById(jobId);
        FirebaseSync.syncJob(created).catch(e => console.warn('[Firebase Sync Error]:', e));
        if (created) emitChange('job', { jobId: created.id, status: created.status, customerPhone: created.customer_phone, workerPhone: created.worker_phone, workerId: created.worker_id, city: created.city });
        return created;
    },

    getJobById(id) {
        if (!db) return memoryStore.jobs.find(j => j.id === id || String(j.id) === String(id)) || null;
        return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) || null;
    },

    getAllJobs(filters = {}) {
        if (!db) {
            let jobs = [...memoryStore.jobs];
            if (filters.status) jobs = jobs.filter(j => j.status === filters.status);
            if (filters.city) jobs = jobs.filter(j => j.city && j.city.toLowerCase() === filters.city.toLowerCase());
            return jobs;
        }

        let query = 'SELECT * FROM jobs WHERE 1=1';
        const params = [];

        if (filters.status) {
            query += ' AND status = ?';
            params.push(filters.status);
        }
        if (filters.city) {
            query += ' AND city = ?';
            params.push(filters.city);
        }

        query += ' ORDER BY created_at DESC';
        return db.prepare(query).all(...params);
    },

    getJobsByCustomer(customerPhoneOrId) {
        if (!customerPhoneOrId) return [];
        const raw = String(customerPhoneOrId).trim();
        if (!db) {
            const clean = normalizePhone(customerPhoneOrId);
            if (clean.length < 10 && !/^\d+$/.test(raw)) return [];
            return memoryStore.jobs.filter(j => normalizePhone(j.customer_phone) === clean || String(j.customer_id) === String(customerPhoneOrId));
        }
        const clean = normalizePhone(customerPhoneOrId);
        if (clean.length < 10 && !/^\d+$/.test(raw)) return [];
        const idNum = !isNaN(Number(customerPhoneOrId)) ? Number(customerPhoneOrId) : -1;
        if (clean.length < 10) {
            return db.prepare('SELECT * FROM jobs WHERE customer_id = ? ORDER BY created_at DESC').all(idNum);
        }
        return db.prepare("SELECT * FROM jobs WHERE (customer_phone IS NOT NULL AND (customer_phone = ? OR customer_phone LIKE ?)) OR (customer_id IS NOT NULL AND customer_id = ?) ORDER BY created_at DESC").all(clean, `%${clean}`, idNum);
    },

    getJobsByWorker(workerIdOrPhone) {
        if (!workerIdOrPhone) return [];
        if (!db) {
            const clean = normalizePhone(workerIdOrPhone);
            return memoryStore.jobs.filter(j => normalizePhone(j.worker_phone) === clean || String(j.worker_id) === String(workerIdOrPhone));
        }
        const cleanPhone = normalizePhone(workerIdOrPhone);
        if (cleanPhone.length >= 10) {
            const w = this.getWorkerByPhone(cleanPhone);
            if (w) {
                return db.prepare('SELECT * FROM jobs WHERE worker_phone = ? OR worker_phone LIKE ? OR worker_id = ? ORDER BY created_at DESC').all(cleanPhone, `%${cleanPhone}`, w.id);
            }
            return db.prepare('SELECT * FROM jobs WHERE worker_phone = ? OR worker_phone LIKE ? ORDER BY created_at DESC').all(cleanPhone, `%${cleanPhone}`);
        }
        if (typeof workerIdOrPhone === 'number' || (!isNaN(Number(workerIdOrPhone)) && Number(workerIdOrPhone) < 1000000)) {
            return db.prepare('SELECT * FROM jobs WHERE worker_id = ? ORDER BY created_at DESC').all(Number(workerIdOrPhone));
        }
        return db.prepare('SELECT * FROM jobs WHERE worker_phone = ? ORDER BY created_at DESC').all(String(workerIdOrPhone));
    },

    recordWorkerJobAction(workerId, jobId, action = 'declined') {
        const cleanAction = String(action || 'declined').trim() || 'declined';
        if (!workerId || !jobId) return null;

        if (!db) {
            memoryStore.workerJobActions = memoryStore.workerJobActions || [];
            const existing = memoryStore.workerJobActions.find(a =>
                String(a.worker_id) === String(workerId) &&
                String(a.job_id) === String(jobId) &&
                String(a.action) === cleanAction
            );
            if (!existing) {
                memoryStore.workerJobActions.unshift({
                    id: Date.now(),
                    worker_id: Number(workerId),
                    job_id: String(jobId),
                    action: cleanAction,
                    created_at: new Date().toISOString()
                });
            }
            return true;
        }

        db.prepare(`
            INSERT OR IGNORE INTO worker_job_actions (worker_id, job_id, action)
            VALUES (?, ?, ?)
        `).run(Number(workerId), String(jobId), cleanAction);
        return true;
    },

    getJobsCancelledByWorker(workerId) {
        if (!workerId) return [];
        if (!db) {
            const ids = new Set((memoryStore.workerJobActions || [])
                .filter(a => String(a.worker_id) === String(workerId) && ['declined', 'cancelled'].includes(String(a.action)))
                .map(a => String(a.job_id)));
            return memoryStore.jobs.filter(j => ids.has(String(j.id)));
        }

        return db.prepare(`
            SELECT j.*
            FROM jobs j
            INNER JOIN worker_job_actions a ON a.job_id = j.id
            WHERE a.worker_id = ?
              AND a.action IN ('declined', 'cancelled')
            GROUP BY j.id
            ORDER BY MAX(a.created_at) DESC, j.created_at DESC
        `).all(Number(workerId));
    },

    getAvailableJobsForWorker(trade, city = 'Ramanagara') {
        const tradeName = String(trade || '').toLowerCase();
        const aliases = {
            electrician: ['electric', 'electrical'],
            electrical: ['electric', 'electrical'],
            plumber: ['plumb', 'plumbing'],
            plumbing: ['plumb', 'plumbing'],
            carpenter: ['carpent', 'carpentry'],
            painting: ['paint', 'painter'],
            painter: ['paint', 'painter'],
            cleaner: ['clean', 'cleaning'],
            'home cleaner': ['clean', 'cleaning'],
            mechanic: ['mechanic', 'mechanics'],
            'ac & fridge tech': ['ac', 'appliance', 'fridge'],
            appliance: ['appliance', 'electronic'],
            tailor: ['tailor', 'tailoring']
        };
        const terms = [tradeName, ...(aliases[tradeName] || [])].filter(Boolean);
        const matchesTrade = job => {
            const text = `${job.service || ''} ${job.problem_description || ''}`.toLowerCase();
            return terms.some(term => text.includes(term));
        };
        if (!db) {
            return memoryStore.jobs.filter(j => j.status === 'Requested'
                && (!city || !j.city || String(j.city).toLowerCase() === String(city).toLowerCase())
                && matchesTrade(j));
        }
        const jobs = db.prepare(`
            SELECT * FROM jobs
            WHERE status = 'Requested'
              AND (? IS NULL OR LOWER(city) = LOWER(?))
            ORDER BY created_at DESC
        `).all(city || null, city || null);
        return jobs.filter(matchesTrade);
    },

    updateJobStatus(jobId, status, workerId = null, workerName = null, workerPhone = null) {
        const job = this.getJobById(jobId);
        if (!job) return null;
        const nextStatus = String(status || '').trim();
        if (!VALID_JOB_STATUSES.has(nextStatus)) return null;
        const wasCompleted = job.status === 'Completed';

        if (!db) {
            job.status = nextStatus;
            if (workerId !== null && workerId !== undefined) {
                job.worker_id = workerId;
                job.worker_name = workerName || 'Worker';
                job.worker_phone = workerPhone ? normalizePhone(workerPhone) : '';
            }
            if (nextStatus === 'Completed' && !wasCompleted) {
                job.completed_at = new Date().toISOString();
                job.payment_status = 'Paid';
                if (job.worker_id) {
                    const w = this.getWorkerById(job.worker_id);
                    if (w) w.jobs_completed = (w.jobs_completed || 0) + 1;
                }
            }
            FirebaseSync.syncJob(job).catch(e => console.warn('[Firebase Sync Error]:', e));
            emitChange('job', { jobId: job.id, status: job.status, customerPhone: job.customer_phone, workerPhone: job.worker_phone, workerId: job.worker_id, city: job.city });
            return job;
        }

        const fields = ['status = ?'];
        const params = [nextStatus];

        if (workerId !== null && workerId !== undefined) {
            fields.push('worker_id = ?', 'worker_name = ?', 'worker_phone = ?');
            params.push(workerId, workerName || 'Worker', workerPhone ? normalizePhone(workerPhone) : '');
        }

        if (nextStatus === 'Completed' && !wasCompleted) {
            fields.push("completed_at = CURRENT_TIMESTAMP", "payment_status = 'Paid'");
            if (job.worker_id) {
                db.prepare('UPDATE workers SET jobs_completed = jobs_completed + 1 WHERE id = ?').run(job.worker_id);
            }
        }

        params.push(jobId);
        db.prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`).run(...params);
        const updated = this.getJobById(jobId);
        FirebaseSync.syncJob(updated).catch(e => console.warn('[Firebase Sync Error]:', e));
        if (updated) emitChange('job', { jobId: updated.id, status: updated.status, customerPhone: updated.customer_phone, workerPhone: updated.worker_phone, workerId: updated.worker_id, city: updated.city });
        return updated;
    },

    // Update editable job fields without duplicating the status transition logic.
    // This is intentionally allow-listed so arbitrary request properties cannot
    // overwrite payment, ownership, or audit fields.
    updateJobDetails(jobId, updates = {}) {
        const job = this.getJobById(jobId);
        if (!job) return null;
        const allowed = {
            service: 'service',
            problem_description: 'problem_description',
            location: 'location',
            city: 'city',
            requested_date: 'requested_date',
            requested_time: 'requested_time',
            requested_end_time: 'requested_end_time',
            budget: 'budget',
            payment_method: 'payment_method'
        };

        if (!db) {
            for (const [key, field] of Object.entries(allowed)) {
                if (updates[key] !== undefined && updates[key] !== null && String(updates[key]).trim() !== '') {
                    job[field] = key === 'requested_date' ? normalizeDateKey(updates[key]) : String(updates[key]).trim();
                }
            }
            if (updates.requested_end_time !== undefined && updates.requested_end_time === null) {
                job.requested_end_time = null;
            }
            if (updates.budget !== undefined) job.final_price = parseInt(String(updates.budget).replace(/\D/g, ''), 10) || job.final_price || 350;
            FirebaseSync.syncJob(job).catch(e => console.warn('[Firebase Sync Error]:', e));
            emitChange('job', { jobId: job.id, status: job.status, customerPhone: job.customer_phone, workerPhone: job.worker_phone, workerId: job.worker_id, city: job.city });
            return job;
        }

        const fields = [];
        const params = [];
        for (const [key, field] of Object.entries(allowed)) {
            if (updates[key] === undefined || updates[key] === null || String(updates[key]).trim() === '') continue;
            fields.push(`${field} = ?`);
            params.push(key === 'requested_date' ? normalizeDateKey(updates[key]) : String(updates[key]).trim());
        }
        if (updates.budget !== undefined && updates.budget !== null) {
            fields.push('final_price = ?');
            params.push(parseInt(String(updates.budget).replace(/\D/g, ''), 10) || job.final_price || 350);
        }
        if (!fields.length) return job;
        params.push(jobId);
        db.prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`).run(...params);
        const updated = this.getJobById(jobId);
        FirebaseSync.syncJob(updated).catch(e => console.warn('[Firebase Sync Error]:', e));
        if (updated) emitChange('job', { jobId: updated.id, status: updated.status, customerPhone: updated.customer_phone, workerPhone: updated.worker_phone, workerId: updated.worker_id, city: updated.city });
        return updated;
    },

    // DELETE is a safe soft-delete for bookings: customers retain a history and
    // workers/admins can still audit what happened.
    deleteJob(jobId) {
        const job = this.getJobById(jobId);
        if (!job || job.status === 'Completed' || job.status === 'Cancelled') return job || null;
        return this.updateJobStatus(jobId, 'Cancelled');
    },

    submitJobReview(jobId, rating, review) {
        const job = this.getJobById(jobId);
        if (!job) return null;

        const score = Number(rating);
        if (!Number.isInteger(score) || score < 1 || score > 5) return null;
        if (job.status !== 'Completed' || job.rating !== null && job.rating !== undefined) return null;
        const safeReview = String(review || '').trim().slice(0, 2000);

        if (!db) {
            job.rating = score;
            job.review = safeReview;
            FirebaseSync.syncJob(job).catch(e => console.warn('[Firebase Sync Error]:', e));
            return job;
        }

        db.prepare('UPDATE jobs SET rating = ?, review = ? WHERE id = ? AND status = \'Completed\' AND rating IS NULL').run(score, safeReview, jobId);
        const saved = db.prepare('SELECT rating FROM jobs WHERE id = ?').get(jobId);
        if (!saved || saved.rating === null || saved.rating === undefined) return null;

        if (job.worker_id) {
            const avgRow = db.prepare('SELECT AVG(rating) as avg_rating FROM jobs WHERE worker_id = ? AND rating IS NOT NULL').get(job.worker_id);
            if (avgRow && avgRow.avg_rating) {
                const rounded = Math.round(avgRow.avg_rating * 10) / 10;
                db.prepare('UPDATE workers SET rating = ? WHERE id = ?').run(rounded, job.worker_id);
            }
        }

        const updated = this.getJobById(jobId);
        FirebaseSync.syncJob(updated).catch(e => console.warn('[Firebase Sync Error]:', e));
        return updated;
    },

    // ---------------- EARNINGS & DIGITAL WORK RECORD ----------------
    getWorkerEarnings(workerIdOrPhone) {
        let worker = null;
        if (typeof workerIdOrPhone === 'string' && workerIdOrPhone.length >= 10) {
            worker = this.getWorkerByPhone(workerIdOrPhone);
        } else if (typeof workerIdOrPhone === 'number') {
            worker = this.getWorkerById(workerIdOrPhone);
        } else if (!isNaN(Number(workerIdOrPhone)) && String(workerIdOrPhone).length < 10) {
            worker = this.getWorkerById(Number(workerIdOrPhone));
        } else {
            worker = this.getWorkerByPhone(workerIdOrPhone);
        }

        const wId = worker ? worker.id : (typeof workerIdOrPhone === 'number' ? workerIdOrPhone : -1);
        const phone = worker ? worker.phone : String(workerIdOrPhone).replace(/\D/g, '');

        if (!db) {
            const completedJobs = memoryStore.jobs.filter(j => (j.worker_phone === phone || (wId && j.worker_id === wId)) && j.status === 'Completed');
            const total = completedJobs.reduce((sum, j) => sum + (j.final_price || 300), 0);
            return {
                today: total,
                thisMonth: total,
                totalEarnings: total,
                totalCompletedJobs: completedJobs.length,
                pendingEarnings: 0,
                completedJobs
            };
        }

        const totalRow = db.prepare(`
            SELECT COALESCE(SUM(COALESCE(final_price, CAST(REPLACE(REPLACE(budget, '₹', ''), ' ', '') AS INTEGER), 300)), 0) as total, COUNT(*) as count
            FROM jobs
            WHERE (worker_id = ? OR worker_phone = ?) AND status = 'Completed'
        `).get(wId, phone);

        const todayRow = db.prepare(`
            SELECT COALESCE(SUM(COALESCE(final_price, CAST(REPLACE(REPLACE(budget, '₹', ''), ' ', '') AS INTEGER), 300)), 0) as today
            FROM jobs
            WHERE (worker_id = ? OR worker_phone = ?) AND status = 'Completed' AND date(completed_at) = date('now')
        `).get(wId, phone);

        const monthRow = db.prepare(`
            SELECT COALESCE(SUM(COALESCE(final_price, CAST(REPLACE(REPLACE(budget, '₹', ''), ' ', '') AS INTEGER), 300)), 0) as month
            FROM jobs
            WHERE (worker_id = ? OR worker_phone = ?) AND status = 'Completed' AND strftime('%Y-%m', completed_at) = strftime('%Y-%m', 'now')
        `).get(wId, phone);

        const pendingRow = db.prepare(`
            SELECT COALESCE(SUM(COALESCE(final_price, CAST(REPLACE(REPLACE(budget, '₹', ''), ' ', '') AS INTEGER), 300)), 0) as pending
            FROM jobs
            WHERE (worker_id = ? OR worker_phone = ?) AND status IN ('Accepted', 'On the Way', 'In Progress')
        `).get(wId, phone);

        const completedJobs = db.prepare(`
            SELECT id, service, customer_name, location, requested_date, final_price, completed_at, payment_status, payment_method, rating
            FROM jobs
            WHERE (worker_id = ? OR worker_phone = ?) AND status = 'Completed'
            ORDER BY completed_at DESC
        `).all(wId, phone);

        return {
            today: todayRow?.today || 0,
            thisMonth: monthRow?.month || 0,
            totalEarnings: totalRow?.total || 0,
            totalCompletedJobs: totalRow?.count || 0,
            pendingEarnings: pendingRow?.pending || 0,
            completedJobs
        };
    },

    getWorkerEarningsSummary(workerIdOrPhone) {
        return this.getWorkerEarnings(workerIdOrPhone);
    },

    // ---------------- CALL LOGS (TELEPHONY / VOICE) ----------------
    logCall({ callerPhone, callerRole = 'customer', transcript, intentDetected, actionsTaken, durationSeconds = 15 }) {
        const clean = (callerPhone || 'anonymous').replace(/\D/g, '') || 'anonymous';
        if (!db) {
            const entry = {
                id: memoryStore.callLogs.length + 1,
                caller_phone: clean,
                caller_role: callerRole,
                transcript,
                intent_detected: intentDetected || 'general_query',
                actions_taken: actionsTaken || 'none',
                duration_seconds: durationSeconds,
                timestamp: new Date().toISOString()
            };
            memoryStore.callLogs.unshift(entry);
            return entry;
        }
        const stmt = db.prepare(`
            INSERT INTO call_logs (caller_phone, caller_role, transcript, intent_detected, actions_taken, duration_seconds)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        const res = stmt.run(clean, callerRole, transcript, intentDetected || 'general_query', actionsTaken || 'none', durationSeconds);
        return db.prepare('SELECT * FROM call_logs WHERE id = ?').get(Number(res.lastInsertRowid));
    },

    getAllCallLogs() {
        if (!db) return [...memoryStore.callLogs];
        return db.prepare('SELECT * FROM call_logs ORDER BY timestamp DESC LIMIT 50').all();
    },

    // ---------------- VOICE SESSIONS (SERVERLESS MULTI-TURN PERSISTENCE) ----------------
    getVoiceSession(sessionId) {
        if (!sessionId) return null;
        if (db) {
            try {
                const stmt = db.prepare('SELECT data FROM voice_sessions WHERE session_id = ?');
                const row = stmt.get(sessionId);
                if (row && row.data) {
                    return JSON.parse(row.data);
                }
            } catch (e) {}
        }
        return memoryStore.voice_sessions?.[sessionId] || null;
    },

    saveVoiceSession(sessionId, data) {
        if (!sessionId || !data) return;
        const jsonStr = JSON.stringify(data);
        if (db) {
            try {
                const stmt = db.prepare(`
                    INSERT INTO voice_sessions (session_id, data, updated_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(session_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
                `);
                stmt.run(sessionId, jsonStr, Date.now());
            } catch (e) {}
        }
        if (!memoryStore.voice_sessions) memoryStore.voice_sessions = {};
        memoryStore.voice_sessions[sessionId] = data;
    },

    deleteVoiceSession(sessionId) {
        if (!sessionId) return;
        if (db) {
            try {
                db.prepare('DELETE FROM voice_sessions WHERE session_id = ?').run(sessionId);
            } catch (e) {}
        }
        if (memoryStore.voice_sessions) {
            delete memoryStore.voice_sessions[sessionId];
        }
    },

    // Clear ALL application data for clean production reset
    clearAllApplicationData() {
        if (db) {
            const tablesToClear = ['workers', 'worker_availability', 'jobs', 'customers', 'call_logs', 'voice_sessions'];
            for (const tbl of tablesToClear) {
                try { db.prepare(`DELETE FROM ${tbl}`).run(); } catch(e){}
            }
            try { db.prepare(`DELETE FROM users WHERE role <> 'admin'`).run(); } catch(e){}
            try { db.exec('VACUUM'); } catch(e){}
        }
        memoryStore.workers = [];
        memoryStore.availability = {};
        memoryStore.jobs = [];
        memoryStore.customers = [];
        memoryStore.reviews = [];
        memoryStore.callLogs = [];
        memoryStore.voice_sessions = {};
        memoryStore.users = memoryStore.users.filter(u => u.role === 'admin');

        FirebaseSync.clearAllData().catch(e => console.warn('[Firebase Clear Error]:', e));
        emitChange('worker', { action: 'CLEARED' });
        emitChange('job', { action: 'CLEARED' });
        emitChange('availability', { action: 'CLEARED' });

        return { success: true, message: 'Clean production dataset ready. Zero workers, zero jobs.' };
    },

    // Trigger complete sync of all SQLite records to Firebase
    async triggerFullFirebaseSync() {
        const allWorkers = this.getAllWorkers();
        const allJobs = this.getAllJobs();
        const allUsers = db ? db.prepare('SELECT * FROM users').all() : memoryStore.users;
        const results = { usersSynced: 0, workersSynced: 0, jobsSynced: 0 };

        for (const user of allUsers) {
            await FirebaseSync.syncUser(user);
            results.usersSynced++;
        }

        for (const w of allWorkers) {
            await FirebaseSync.syncWorker(w);
            results.workersSynced++;
        }
        for (const j of allJobs) {
            await FirebaseSync.syncJob(j);
            results.jobsSynced++;
        }
        return results;
    }
};

module.exports = DB;
