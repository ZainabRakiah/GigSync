/* ==========================================================================
   GigSync — Full-Stack Server & REST API Gateway (Desktop-First)
   Port 8089: Authentication, SQLite Persistence, Firebase Cloud Sync, AI Voice
   ========================================================================== */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const DB = require('./database');
const FirebaseSync = require('./firebase');
const { aiAgent, AI_TOOLS, sessionManager } = require('./ai_agent');
const { authorizeJobMutation, workerForSession, samePhone } = require('./job_policy');

const PORT = 8089;
const PUBLIC_DIR = path.join(__dirname, '..');

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8'
};

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (err) {
                resolve({});
            }
        });
        req.on('error', reject);
    });
}

function sendJSON(res, data, statusCode = 200) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end(JSON.stringify(data));
}

// Availability is a worker-owned resource. Resolve the route target from the
// authenticated session instead of trusting worker_id/worker_phone in a body.
// Admins may operate on an explicit worker id for support tasks; normal workers
// may only operate on their own profile (or the /me alias).
function authorizedWorkerRoute(req, routeWorkerId) {
    const session = getAuthSession(req);
    if (!session) return { error: { code: 401, message: 'Authentication is required.' } };

    if (routeWorkerId === 'me') {
        if (session.role !== 'worker') {
            return { error: { code: 403, message: 'Worker authorization required.' } };
        }
        const worker = workerForSession(session);
        return worker
            ? { session, worker }
            : { error: { code: 404, message: 'Worker profile not found.' } };
    }

    const worker = DB.getWorkerById(Number(routeWorkerId));
    if (!worker) return { error: { code: 404, message: 'Worker profile not found.' } };
    if (session.role === 'admin') return { session, worker };

    const ownWorker = workerForSession(session);
    if (session.role !== 'worker' || !ownWorker || Number(ownWorker.id) !== Number(worker.id)) {
        return { error: { code: 403, message: 'You can only manage your own availability.' } };
    }
    return { session, worker };
}

// Caller identity lives in backend/caller_identity.js so that this server and the
// Vercel handler resolve "who is on the line" with the exact same rule. See that
// file for why the session — not the request body — decides.
const { resolveAiCaller, getAuthSession } = require('./caller_identity');

const server = http.createServer(async (req, res) => {
    // CORS Preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });
        res.end();
        return;
    }

    const host = req.headers.host || `localhost:${PORT}`;
    const parsedUrl = new URL(req.url, `http://${host}`);
    const pathname = parsedUrl.pathname;
    const query = Object.fromEntries(parsedUrl.searchParams.entries());
    const params = parsedUrl.searchParams;
    parsedUrl.query = query;

    /* ----------------------------------------------------------------------
       0. LIVE CHANGE STREAM (Server-Sent Events)

       GET /api/events — a long-lived stream that pushes one message every time a
       worker, availability slot or job actually changes in the database.

       Why this exists: a customer looking at the specialist list used to see
       whatever was loaded when the page opened. If a worker changed their hours
       on the 3.5mm voice line a second later, the customer's screen kept showing
       the old ones until they manually refreshed.

       Why it is fed from the database and not from a browser Firestore listener:
       the browser has no Firebase SDK here (by design — one AI brain, one data
       path through the backend), and Firestore is currently a mirror of SQLite
       rather than the authority. Pushing from the write path means the customer
       sees the same truth the AI just wrote, including when the cloud mirror is
       failing. Events carry only what changed; the client re-reads through the
       normal API, so there is exactly one code path that produces the data.
       ---------------------------------------------------------------------- */
    if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*'
        });

        // Tell the client it is connected, so the UI can show a live indicator that
        // reflects a real open stream rather than an assumption.
        res.write(`event: ready\ndata: ${JSON.stringify({ connected: true })}\n\n`);

        const unsubscribe = DB.onChange((change) => {
            try {
                res.write(`event: change\ndata: ${JSON.stringify(change)}\n\n`);
            } catch (_) {
                // Socket already gone; the close handler will clean up.
            }
        });

        // Comment frames keep proxies and browsers from dropping an idle stream.
        const heartbeat = setInterval(() => {
            try { res.write(': keep-alive\n\n'); } catch (_) {}
        }, 25000);

        const cleanup = () => {
            clearInterval(heartbeat);
            unsubscribe();
        };
        req.on('close', cleanup);
        req.on('error', cleanup);
        return;
    }

    /* ----------------------------------------------------------------------
       1. AUTHENTICATION REST API
       ---------------------------------------------------------------------- */

    // POST /api/auth/register
    if (pathname === '/api/auth/register' && req.method === 'POST') {
        const body = await parseBody(req);
        if (!body.name || !body.phone || !body.password || !body.role) {
            return sendJSON(res, { status: 'error', message: 'Name, mobile number, password, and role are required.' }, 400);
        }

        const cleanPhone = body.phone.replace(/\D/g, '');
        const existing = DB.getUserByPhone(cleanPhone);
        if (existing) {
            return sendJSON(res, { status: 'error', message: 'An account with this phone number already exists. Please log in.' }, 409);
        }

        // Security Check: Restrict Admin Registration
        if (body.role === 'admin') {
            const adminSecret = body.adminSecret || body.admin_secret || '';
            const validSecret = (process.env.ADMIN_SECRET_KEY || '').trim();
            if (adminSecret !== validSecret) {
                return sendJSON(res, {
                    status: 'error',
                    message: 'Access Denied: A valid Master Admin Security Key is required to create an Administrator account.'
                }, 403);
            }
        }

        const user = DB.createUser({
            name: body.name.trim(),
            phone: cleanPhone,
            email: body.email ? body.email.trim() : null,
            role: body.role,
            password: body.password,
            city: body.city || 'Ramanagara',
            area: body.area || 'Town'
        });

        if (body.role === 'worker') {
            const worker = DB.getWorkerByUserId(user.id);
            if (worker && (body.trade || body.skills || body.tools || body.price)) {
                DB.updateWorkerProfile(worker.id, {
                    trade: body.trade || 'General Specialist',
                    skills: body.skills || '',
                    tools: body.tools || 'Standard tool kit',
                    price: body.price || 300,
                    about: body.about || ''
                });
            }
        }

        const session = DB.authenticateUser(cleanPhone, body.password);
        return sendJSON(res, { status: 'success', message: 'Account registered successfully.', ...session }, 201);
    }

    // POST /api/auth/login
    if (pathname === '/api/auth/login' && req.method === 'POST') {
        const body = await parseBody(req);
        if (!body.phone || !body.password) {
            return sendJSON(res, { status: 'error', message: 'Mobile number and password are required.' }, 400);
        }

        const cleanPhone = body.phone.replace(/\D/g, '');
        const session = DB.authenticateUser(cleanPhone, body.password);
        if (!session) {
            return sendJSON(res, { status: 'error', message: 'Invalid mobile number or password.' }, 401);
        }

        return sendJSON(res, { status: 'success', message: 'Login successful.', ...session });
    }

    // GET /api/auth/me
    if (pathname === '/api/auth/me' && req.method === 'GET') {
        const session = getAuthSession(req);
        if (!session) {
            return sendJSON(res, { status: 'error', message: 'Unauthorized or session expired.' }, 401);
        }

        let profile = null;
        if (session.role === 'worker') {
            profile = DB.getWorkerByUserId(session.user_id);
        } else {
            profile = DB.getUserById(session.user_id);
        }

        return sendJSON(res, {
            status: 'success',
            user: {
                id: session.user_id,
                name: session.name,
                phone: session.phone,
                email: session.email,
                role: session.role,
                city: session.city,
                area: session.area,
                profile
            }
        });
    }

    // POST /api/auth/logout
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
        const authHeader = req.headers['authorization'] || '';
        if (authHeader.startsWith('Bearer ')) {
            DB.deleteSession(authHeader.slice(7).trim());
        }
        return sendJSON(res, { status: 'success', message: 'Logged out successfully.' });
    }

    /* ----------------------------------------------------------------------
       2. WORKERS REST API
       ---------------------------------------------------------------------- */

    // GET /api/workers
    if (pathname === '/api/workers' && req.method === 'GET') {
        const filters = {
            service: parsedUrl.query.service || null,
            city: parsedUrl.query.city || null,
            minRating: parsedUrl.query.minRating || null,
            isAvailable: parsedUrl.query.available !== undefined ? parsedUrl.query.available === 'true' : undefined
        };
        const workers = DB.getAllWorkers(filters);
        return sendJSON(res, { status: 'success', count: workers.length, workers });
    }

    // GET /api/workers/:id
    const workerMatch = pathname.match(/^\/api\/workers\/(\d+)$/);
    if (workerMatch && req.method === 'GET') {
        const workerId = Number(workerMatch[1]);
        const worker = DB.getWorkerById(workerId);
        if (!worker) return sendJSON(res, { status: 'error', message: 'Worker not found.' }, 404);
        return sendJSON(res, { status: 'success', worker });
    }

    // GET /api/workers/:id/schedule & GET /api/workers/me/schedule
    const schedMatch = pathname.match(/^\/api\/workers\/(me|\d+)\/schedule$/);
    if (schedMatch && req.method === 'GET') {
        let workerId = schedMatch[1];
        if (workerId === 'me') {
            const session = getAuthSession(req);
            if (!session || session.role !== 'worker') {
                return sendJSON(res, { status: 'error', message: 'Worker authorization required.' }, 403);
            }
            const worker = DB.getWorkerByUserId(session.user_id);
            if (!worker) return sendJSON(res, { status: 'error', message: 'Worker profile not found.' }, 404);
            workerId = worker.id;
        } else {
            workerId = Number(workerId);
        }
        const schedule = DB.getWorkerSchedule(workerId);
        if (!schedule) return sendJSON(res, { status: 'error', message: 'Worker schedule not found.' }, 404);
        return sendJSON(res, { status: 'success', ...schedule });
    }

    // GET /api/workers/:id/earnings
    const earnMatch = pathname.match(/^\/api\/workers\/(\d+)\/earnings$/);
    if (earnMatch && req.method === 'GET') {
        const workerId = Number(earnMatch[1]);
        const earnings = DB.getWorkerEarnings(workerId);
        return sendJSON(res, { status: 'success', workerId, earnings });
    }

    // POST or PATCH /api/workers/me/availability or /api/workers/:id/availability
    // Accepts pattern format or legacy format:
    //   { pattern: 'once'|'daily'|'weekly', daysOfWeek: [0-6], rangeStart/date, rangeEnd,
    //     start_time/startTime, end_time/endTime, is_available }
    const availRouteMatch = pathname.match(/^\/api\/workers\/(me|\d+)\/availability$/);
    if (availRouteMatch && (req.method === 'PATCH' || req.method === 'POST')) {
        const access = authorizedWorkerRoute(req, availRouteMatch[1]);
        if (access.error) return sendJSON(res, { status: 'error', message: access.error.message }, access.error.code);
        const { worker } = access;
        const body = await parseBody(req);

        // Toggle overall duty status
        if (body.is_available !== undefined) {
            DB.updateWorkerAvailabilityStatus(worker.id, body.is_available);
        }

        // Slot / pattern save
        const startTime  = body.start_time || body.startTime;
        const endTime    = body.end_time   || body.endTime;
        const pattern    = body.pattern    || 'once';
        const daysOfWeek = body.days_of_week || body.daysOfWeek || [];
        const rangeStart = body.range_start || body.rangeStart || body.date_str || body.date;
        const rangeEnd   = body.range_end   || body.rangeEnd   || null;

        if (startTime && endTime && rangeStart) {
            DB.setWorkerAvailabilitySlot({
                workerId:    worker.id,
                workerPhone: worker.phone,
                trade:       worker.trade,
                dateStr:     rangeStart,
                startTime,
                endTime,
                isAvailable: body.is_available !== undefined ? body.is_available : true,
                notes:       body.notes || '',
                pattern,
                daysOfWeek,
                rangeStart,
                rangeEnd
            });
        }

        const updated = DB.getWorkerSchedule(worker.id);
        return sendJSON(res, { status: 'success', message: 'Availability updated successfully.', ...updated });
    }

    // GET /api/workers/me/availability/conflicts or GET /api/workers/:id/availability/conflicts
    // Pre-flight check: given proposed new slots, which future confirmed jobs are affected?
    const conflictRouteMatch = pathname.match(/^\/api\/workers\/(me|\d+)\/availability\/conflicts$/);
    if (conflictRouteMatch && req.method === 'GET') {
        const access = authorizedWorkerRoute(req, conflictRouteMatch[1]);
        if (access.error) return sendJSON(res, { status: 'error', message: access.error.message }, access.error.code);
        const { worker } = access;

        // proposedSlots comes as a URL-encoded JSON string: ?slots=[{...}]
        let proposedSlots = [];
        try { proposedSlots = JSON.parse(params.get('slots') || '[]'); } catch (_) {}

        const conflicts = DB.getConflictingJobsForAvailabilityChange(worker.id, proposedSlots);
        return sendJSON(res, { status: 'success', conflicts });
    }

    // POST /api/workers/me/availability/resolve or POST /api/workers/:id/availability/resolve
    // Worker submits per-job decision: [{ jobId, canWork: true/false }]
    const resolveRouteMatch = pathname.match(/^\/api\/workers\/(me|\d+)\/availability\/resolve$/);
    if (resolveRouteMatch && req.method === 'POST') {
        const access = authorizedWorkerRoute(req, resolveRouteMatch[1]);
        if (access.error) return sendJSON(res, { status: 'error', message: access.error.message }, access.error.code);
        const { session, worker } = access;
        const body = await parseBody(req);
        const decisions = Array.isArray(body.decisions) ? body.decisions : [];
        if (decisions.length > 100) return sendJSON(res, { status: 'error', message: 'Too many availability decisions.' }, 400);
        const results = decisions.map(d => {
            const job = DB.getJobById(d.jobId);
            const ownsJob = session.role === 'admin'
                || (job && (Number(job.worker_id) === Number(worker.id) || samePhone(job.worker_phone, worker.phone)));
            if (!ownsJob) return { jobId: d.jobId, action: 'not_allowed' };
            return DB.resolveAvailabilityConflict(d.jobId, Boolean(d.canWork));
        });
        return sendJSON(res, { status: 'success', results });
    }


    // GET /api/workers/available?date=YYYY-MM-DD&city=X
    // Customer calendar: which workers have availability on a given date?
    if (pathname === '/api/workers/available' && req.method === 'GET') {
        const date = params.get('date');
        const city = params.get('city') || null;
        const requestedTime = params.get('requested_time') || params.get('time') || null;
        const requestedEndTime = params.get('requested_end_time') || params.get('end_time') || null;
        if (!date) return sendJSON(res, { status: 'error', message: 'date parameter required.' }, 400);
        const workers = DB.getWorkersAvailableOnDate(date, city, requestedTime, requestedEndTime);
        return sendJSON(res, { status: 'success', workers });
    }


    // PATCH /api/workers/me/profile
    if (pathname === '/api/workers/me/profile' && req.method === 'PATCH') {
        const session = getAuthSession(req);
        if (!session || session.role !== 'worker') {
            return sendJSON(res, { status: 'error', message: 'Worker authorization required.' }, 403);
        }

        const body = await parseBody(req);
        const worker = DB.getWorkerByUserId(session.user_id);
        if (!worker) return sendJSON(res, { status: 'error', message: 'Worker profile not found.' }, 404);

        const updated = DB.updateWorkerProfile(worker.id, body);
        return sendJSON(res, { status: 'success', message: 'Profile updated successfully.', worker: updated });
    }

    // PATCH /api/customers/me/profile
    if (pathname === '/api/customers/me/profile' && req.method === 'PATCH') {
        const session = getAuthSession(req);
        if (!session) {
            return sendJSON(res, { status: 'error', message: 'Authentication required.' }, 401);
        }

        const body = await parseBody(req);
        const customer = DB.updateCustomerProfile(session.phone, {
            name: body.name,
            city: body.city,
            area: body.area,
            email: body.email
        });
        if (!customer) return sendJSON(res, { status: 'error', message: 'Customer profile not found.' }, 404);

        // updateCustomerProfile already handles users table update internally

        return sendJSON(res, { status: 'success', message: 'Profile updated.', customer });
    }



    /* ----------------------------------------------------------------------
       3. JOBS & BOOKINGS REST API
       ---------------------------------------------------------------------- */

    // GET /api/jobs
    if (pathname === '/api/jobs' && req.method === 'GET') {
        const session = getAuthSession(req);
        const status = parsedUrl.query.status || null;
        const city = parsedUrl.query.city || null;
        const phone = parsedUrl.query.phone || parsedUrl.query.customer_phone || null;
        const workerPhone = parsedUrl.query.worker_phone || null;

        let jobs = [];
        let availableOpportunities = [];
        let workerCancelledJobs = [];

        if (session && session.role === 'worker') {
            const worker = DB.getWorkerByUserId(session.user_id) || DB.getWorkerByPhone(session.phone);
            if (worker) {
                jobs = DB.getJobsByWorker(worker.phone || worker.id);
                availableOpportunities = DB.getAvailableJobsForWorker(worker.trade, worker.city);
                workerCancelledJobs = DB.getJobsCancelledByWorker(worker.id);
            }
        } else if (session && session.role === 'customer') {
            jobs = DB.getJobsByCustomer(session.phone);
        } else if (phone || workerPhone) {
            return sendJSON(res, { status: 'error', message: 'Authentication is required to query bookings.' }, 401);
        } else if (session && session.role === 'admin') {
            jobs = DB.getAllJobs({ status, city });
        } else {
            // Unauthenticated / generic query without phone returns ZERO jobs — never leak other customers' bookings!
            jobs = [];
        }

        return sendJSON(res, {
            status: 'success',
            count: jobs.length,
            jobs,
            opportunities: availableOpportunities,
            workerCancelledJobs
        });
    }

    // POST /api/jobs
    if (pathname === '/api/jobs' && req.method === 'POST') {
        const body = await parseBody(req);
        const session = getAuthSession(req);
        if (session && !['customer', 'admin'].includes(session.role)) {
            return sendJSON(res, { status: 'error', message: 'Only customers or administrators can create bookings.' }, 403);
        }
        const customerPhone = String(session?.role === 'customer' ? session.phone : (body.customer_phone || '')).replace(/\D/g, '').slice(-10);
        if (!body.service || !String(body.service).trim() || !body.problem_description || !String(body.problem_description).trim() || customerPhone.length < 10) {
            return sendJSON(res, { status: 'error', message: 'Service, problem description, and customer phone are required.' }, 400);
        }

        let selectedWorker = null;
        if (body.worker_id !== undefined && body.worker_id !== null && String(body.worker_id) !== '') {
            selectedWorker = DB.getWorkerById(Number(body.worker_id));
            if (!selectedWorker) return sendJSON(res, { status: 'error', message: 'Selected worker was not found.' }, 404);
        } else if (body.worker_phone) {
            selectedWorker = DB.getWorkerByPhone(body.worker_phone);
            if (!selectedWorker) return sendJSON(res, { status: 'error', message: 'Selected worker was not found.' }, 404);
        }

        // Schedule Conflict Prevention Check
        const requestedEndTime = body.requested_end_time || body.requestedEndTime || null;
        if (selectedWorker && body.requested_date && body.requested_time && !['Today', 'Immediate'].includes(String(body.requested_date))) {
            const hasConflict = DB.checkScheduleConflict(selectedWorker.id, body.requested_date, body.requested_time, requestedEndTime);
            if (hasConflict) {
                return sendJSON(res, {
                    status: 'error',
                    message: hasConflict === 'NotAvailable'
                        ? 'This worker has not set availability for the selected date.'
                        : hasConflict === 'OutsideHours'
                            ? 'The selected time is outside this worker\'s working hours.'
                            : 'This worker already has an accepted booking during this time slot. Please choose another time or worker.'
                }, 409);
            }
        }

        try {
            const newJob = DB.createJob({
                customer_id: session?.role === 'customer' ? session.user_id : (session?.role === 'admin' ? body.customer_id : null),
                customer_phone: customerPhone,
                customer_name: session?.role === 'customer' ? session.name : (body.customer_name || 'Customer'),
                worker_id: selectedWorker ? selectedWorker.id : null,
                worker_phone: selectedWorker ? selectedWorker.phone : null,
                worker_name: selectedWorker ? selectedWorker.name : 'Broadcasting to nearby verified specialists...',
                service: body.service,
                problem_description: body.problem_description,
                location: body.location || 'Town Area',
                city: body.city || (session?.city || 'Ramanagara'),
                requested_date: body.requested_date || 'Today',
                requested_time: body.requested_time || 'Immediate',
                requested_end_time: requestedEndTime,
                budget: body.budget || '₹350',
                status: selectedWorker ? (body.status || 'Confirmed') : 'Requested',
                payment_method: body.payment_method || 'Cash'
            });
            return sendJSON(res, { status: 'success', message: 'Job created and dispatched.', job: newJob }, 201);
        } catch (err) {
            return sendJSON(res, { status: 'error', message: err.message || 'The job could not be saved.' }, 400);
        }
    }

    // GET /api/jobs/:id
    const jobUpdateMatch = pathname.match(/^\/api\/jobs\/([A-Za-z0-9-]+)$/);
    if (jobUpdateMatch && req.method === 'GET') {
        const session = getAuthSession(req);
        const job = DB.getJobById(jobUpdateMatch[1]);
        if (!job) return sendJSON(res, { status: 'error', message: 'Job not found.' }, 404);
        if (!session) return sendJSON(res, { status: 'error', message: 'Authentication is required.' }, 401);

        const worker = workerForSession(session);
        const canRead = session.role === 'admin'
            || (session.role === 'customer' && (samePhone(job.customer_phone, session.phone) || String(job.customer_id) === String(session.user_id)))
            || (session.role === 'worker' && worker && (Number(job.worker_id) === Number(worker.id) || samePhone(job.worker_phone, worker.phone)));
        if (!canRead) return sendJSON(res, { status: 'error', message: 'You are not allowed to view this booking.' }, 403);
        return sendJSON(res, { status: 'success', job });
    }

    // PATCH/PUT /api/jobs/:id
    if (jobUpdateMatch && (req.method === 'PATCH' || req.method === 'PUT')) {
        const jobId = jobUpdateMatch[1];
        const body = await parseBody(req);
        const session = getAuthSession(req);
        const job = DB.getJobById(jobId);
        if (!job) return sendJSON(res, { status: 'error', message: 'Job not found.' }, 404);
        if (!session) return sendJSON(res, { status: 'error', message: 'Authentication is required to change a booking.' }, 401);

        const hasStatus = body.status !== undefined && body.status !== null && String(body.status).trim() !== '';
        const nextStatus = hasStatus ? String(body.status).trim() : job.status;
        const hasDetails = ['service', 'problem_description', 'location', 'city', 'requested_date', 'requested_time', 'requested_end_time', 'budget', 'payment_method']
            .some(key => body[key] !== undefined);
        if (!hasStatus && !(session.role === 'admin' && hasDetails) && !(session.role === 'worker' && body.worker_action)) {
            return sendJSON(res, { status: 'error', message: 'A new status is required.' }, 400);
        }

        if (session.role === 'worker' && body.worker_action) {
            const worker = DB.getWorkerByUserId(session.user_id) || DB.getWorkerByPhone(session.phone);
            if (!worker) return sendJSON(res, { status: 'error', message: 'Worker profile not found.' }, 404);
            const workerAction = String(body.worker_action).toLowerCase().trim();
            if (!['decline', 'cancel', 'cancelled'].includes(workerAction)) {
                return sendJSON(res, { status: 'error', message: 'Unsupported worker action.' }, 400);
            }
            const result = DB.workerCancelJob(jobId, worker.id, worker.name, worker.phone);
            if (!result.ok) return sendJSON(res, { status: 'error', message: result.message || 'Unable to cancel the booking.' }, 409);
            const updatedJob = result.job || DB.getJobById(jobId);
            return sendJSON(res, { status: 'success', message: 'Your copy of this request was moved to cancelled bookings.', job: updatedJob });
        }

        const decision = authorizeJobMutation(job, session, nextStatus);
        if (!decision.ok) return sendJSON(res, { status: 'error', message: decision.message }, decision.code);

        // A worker may claim an unassigned Requested job, but never by sending a
        // forged worker_id. The policy result is the source of truth.
        if (decision.worker && !job.worker_id && !job.worker_phone && hasStatus && ['Confirmed', 'Accepted'].includes(nextStatus)
            && job.requested_date && job.requested_time && !['Today', 'Immediate'].includes(String(job.requested_date))) {
            const conflict = DB.checkScheduleConflict(decision.worker.id, job.requested_date, job.requested_time, job.requested_end_time);
            if (conflict) return sendJSON(res, { status: 'error', message: 'This booking does not fit your availability or conflicts with another job.' }, 409);
        }

        let updated = job;
        if (hasStatus || decision.worker) {
            updated = DB.updateJobStatus(jobId, nextStatus,
                decision.worker ? decision.worker.id : null,
                decision.worker ? decision.worker.name : null,
                decision.worker ? decision.worker.phone : null);
        }
        if (session.role === 'admin' && hasDetails) updated = DB.updateJobDetails(jobId, body);
        if (!updated) return sendJSON(res, { status: 'error', message: 'Booking could not be updated.' }, 409);

        return sendJSON(res, { status: 'success', message: `Job #${jobId} updated.`, job: updated });
    }

    // DELETE /api/jobs/:id — soft-cancel so booking history remains auditable.
    if (jobUpdateMatch && req.method === 'DELETE') {
        const job = DB.getJobById(jobUpdateMatch[1]);
        const session = getAuthSession(req);
        const decision = authorizeJobMutation(job, session, 'Cancelled');
        if (!decision.ok) return sendJSON(res, { status: 'error', message: decision.message }, decision.code);
        const updated = DB.deleteJob(job.id);
        return sendJSON(res, { status: 'success', message: `Job #${job.id} cancelled.`, job: updated });
    }

    // POST /api/jobs/:id/review
    const jobReviewMatch = pathname.match(/^\/api\/jobs\/([A-Za-z0-9-]+)\/review$/);
    if (jobReviewMatch && req.method === 'POST') {
        const jobId = jobReviewMatch[1];
        const body = await parseBody(req);
        const session = getAuthSession(req);
        const job = DB.getJobById(jobId);
        if (!session) return sendJSON(res, { status: 'error', message: 'Authentication is required to review a booking.' }, 401);
        if (!job) return sendJSON(res, { status: 'error', message: 'Job not found.' }, 404);
        const ownsJob = session.role === 'admin'
            || (session.role === 'customer' && (samePhone(job.customer_phone, session.phone) || String(job.customer_id) === String(session.user_id)));
        if (!ownsJob) return sendJSON(res, { status: 'error', message: 'Only the customer who booked this service can review it.' }, 403);
        const rating = Number(body.rating);
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
            return sendJSON(res, { status: 'error', message: 'Rating (1 to 5) is required.' }, 400);
        }
        if (job.status !== 'Completed') return sendJSON(res, { status: 'error', message: 'You can review a booking after it is completed.' }, 409);
        if (job.rating !== null && job.rating !== undefined) return sendJSON(res, { status: 'error', message: 'This booking has already been reviewed.' }, 409);

        const updated = DB.submitJobReview(jobId, rating, body.review || '');
        if (!updated) return sendJSON(res, { status: 'error', message: 'Job not found.' }, 404);

        return sendJSON(res, { status: 'success', message: 'Review submitted.', job: updated });
    }

    /* ----------------------------------------------------------------------
       4. FIREBASE CLOUD FIRESTORE ENDPOINTS
       ---------------------------------------------------------------------- */

    // GET /api/firebase/config
    if (pathname === '/api/firebase/config' && req.method === 'GET') {
        return sendJSON(res, {
            status: 'success',
            config: FirebaseSync.getConfig()
        });
    }

    // POST /api/firebase/config
    if (pathname === '/api/firebase/config' && req.method === 'POST') {
        const body = await parseBody(req);
        const updated = FirebaseSync.saveConfig(body);
        return sendJSON(res, { status: 'success', message: 'Firebase config updated.', config: updated });
    }

    // POST /api/firebase/sync
    if (pathname === '/api/firebase/sync' && req.method === 'POST') {
        const syncResult = await DB.triggerFullFirebaseSync();
        return sendJSON(res, {
            status: 'success',
            message: 'All local workers and jobs synchronized to Cloud Firestore collections.',
            ...syncResult
        });
    }

    // POST /api/admin/clear-data (Clean Production Data Reset)
    if (pathname === '/api/admin/clear-data' && req.method === 'POST') {
        const session = getAuthSession(req);
        const body = await parseBody(req);
        const configuredSecret = (process.env.ADMIN_SECRET_KEY || '').trim();
        const suppliedSecret = String(body.adminSecret || body.admin_secret || '').trim();
        if (!configuredSecret) {
            return sendJSON(res, { status: 'error', message: 'Admin reset is not configured. Set ADMIN_SECRET_KEY in the server environment.' }, 503);
        }
        if (!session || session.role !== 'admin') {
            return sendJSON(res, { status: 'error', message: 'Administrator login is required.' }, 403);
        }
        if (!suppliedSecret || suppliedSecret !== configuredSecret) {
            return sendJSON(res, { status: 'error', message: 'Invalid administrator security key.' }, 403);
        }
        const clearRes = DB.clearAllApplicationData();
        return sendJSON(res, {
            status: 'success',
            message: 'Clean production data reset complete. Database and Firestore cleared.',
            ...clearRes
        });
    }

    /* ----------------------------------------------------------------------
       5. AI VOICE & CONVERSATIONAL GATEWAY
       ---------------------------------------------------------------------- */

    // GET /api/ai/caller?phone=XXXXXXXXXX
    //
    // Resolves who a number belongs to using the SAME rule the AI endpoint uses, so the
    // 3.5mm voice terminal can confirm the person on the handset before the call starts
    // and cannot end up talking to a different record than the one it displayed.
    if (pathname === '/api/ai/caller' && req.method === 'GET') {
        const session = getAuthSession(req);
        const identity = resolveAiCaller(session, { callerPhone: parsedUrl.query.phone || '' });
        if (identity.error) {
            return sendJSON(res, { status: 'error', message: identity.error }, identity.statusCode || 400);
        }
        return sendJSON(res, {
            status: 'success',
            caller: {
                phone: identity.callerPhone,
                name: identity.callerName,
                role: identity.callerRole,
                city: identity.city,
                source: identity.source,
                registeredWorker: identity.registeredWorker
            }
        });
    }

    // POST /api/ai/reset-session
    if (pathname === '/api/ai/reset-session' && req.method === 'POST') {
        const body = await parseBody(req);
        if (body && body.sessionId) {
            sessionManager.resetSession(body.sessionId);
        }
        return sendJSON(res, { status: 'success', message: 'Voice session reset.' });
    }

    // POST /api/ai/voice-call & POST /api/ai/chat
    if ((pathname === '/api/ai/voice-call' || pathname === '/api/ai/chat') && req.method === 'POST') {
        const body = await parseBody(req);
        const isVoice = (pathname === '/api/ai/voice-call') || body.isVoiceCall === true || body.portal === 'terminal';
        const session = (body.portal === 'terminal' && !body.callerPhone) ? null : getAuthSession(req);
        const speechText = body.speechText || body.message || '';

        if (!speechText) {
            return sendJSON(res, { status: 'error', message: 'speechText or message is required.' }, 400);
        }

        const identity = resolveAiCaller(session, { ...body, isVoiceCall: isVoice, role: body.role || session?.role });
        if (identity.error) {
            return sendJSON(res, { status: 'error', message: identity.error }, identity.statusCode || 400);
        }

        try {
            const aiTurn = await aiAgent.processCallTurn({
                sessionId: body.sessionId || (identity.callerPhone ? `${identity.callerRole}_${identity.callerPhone}` : `sess_${Date.now()}`),
                callerPhone: identity.callerPhone,
                customerId: identity.customerId || (session && session.role === 'customer' ? session.user_id : null),
                workerId: identity.workerId || (identity.workerProfile ? identity.workerProfile.id : null),
                callerRole: identity.callerRole,
                callerName: identity.callerName,
                city: identity.city,
                isVoiceCall: isVoice,
                portal: body.portal,
                language: /^(EN|KN|HN|HI)$/i.test(body.language || '') ? (String(body.language).toUpperCase() === 'HI' ? 'HN' : String(body.language).toUpperCase()) : 'EN',
                speechText
            });

            return sendJSON(res, {
                status: 'success',
                callerIdentity: {
                    phone: identity.callerPhone,
                    name: identity.callerName,
                    role: identity.callerRole,
                    source: identity.source,
                    registeredWorker: identity.registeredWorker
                },
                ...aiTurn
            });
        } catch (err) {
            console.error('AI Processing Error:', err);
            return sendJSON(res, {
                status: 'error',
                message: 'AI voice agent processing failed.',
                error: err.message
            }, 500);
        }
    }

    // GET & POST /api/ai/tts (Real-Time Text-to-Speech Audio Stream)
    if (pathname === '/api/ai/tts' && (req.method === 'GET' || req.method === 'POST')) {
        let text = '';
        let lang = 'en-IN';
        if (req.method === 'GET') {
            text = (parsedUrl.query && parsedUrl.query.text) ? parsedUrl.query.text : '';
            lang = (parsedUrl.query && parsedUrl.query.lang) ? parsedUrl.query.lang : 'en-IN';
        } else {
            const body = await parseBody(req);
            text = body.text || '';
            lang = body.lang || 'en-IN';
        }

        if (!text) {
            return sendJSON(res, { status: 'error', message: 'Text is required for TTS' }, 400);
        }

        const requestedLang = String(lang || 'en-IN').toLowerCase();
        const isKannada = /[\u0C80-\u0CFF]/.test(text);
        const isHindi = /[\u0900-\u097F]/.test(text);
        const targetLang = isKannada ? 'kn' : (isHindi ? 'hi' : (requestedLang.startsWith('kn') ? 'kn' : requestedLang.startsWith('hi') ? 'hi' : 'en')); 
        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text.slice(0, 200))}&tl=${targetLang}&client=tw-ob`;

        const https = require('node:https');
        https.get(ttsUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (ttsRes) => {
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            ttsRes.pipe(res);
        }).on('error', (err) => {
            console.error('TTS Proxy Error:', err);
            sendJSON(res, { status: 'error', message: 'TTS audio generation failed', error: err.message }, 500);
        });
        return;
    }

    // GET /api/call-logs
    if (pathname === '/api/call-logs' && req.method === 'GET') {
        const logs = DB.getAllCallLogs();
        return sendJSON(res, { status: 'success', count: logs.length, callLogs: logs });
    }

    /* ----------------------------------------------------------------------
       6. STATIC WEB APPLICATION SERVING
       ---------------------------------------------------------------------- */

    let reqPath = pathname === '/' ? '/index.html' : pathname;
    const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(PUBLIC_DIR, safePath);

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            const fallbackPath = path.join(PUBLIC_DIR, 'index.html');
            fs.readFile(fallbackPath, (fallbackErr, content) => {
                if (fallbackErr) {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('404 Not Found');
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(content);
            });
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        fs.readFile(filePath, (readErr, content) => {
            if (readErr) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('500 Server Error');
                return;
            }
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        });
    });
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.warn(`[Server] Port ${PORT} already in use. Retrying or using existing server instance.`);
    } else {
        console.error('[Server Error]:', err.message);
    }
});

process.on('uncaughtException', (err) => {
    console.error('[Uncaught Exception]:', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('[Unhandled Rejection]:', reason);
});

server.listen(PORT, () => {
    console.log('=======================================================');
    console.log(` GigSync Full-Stack Desktop Server & AI Voice Gateway`);
    console.log(` Running at: http://localhost:${PORT}/`);
    console.log(` SQLite Database: Connected (gigsync.db)`);
    console.log(` Firebase Cloud Sync: Connected (Firestore REST Layer)`);
    console.log(` Real Authentication: Enabled (/api/auth/*)`);
    console.log(` Desktop Customer & Worker REST Endpoints: Live`);
    console.log('=======================================================');
});

module.exports = server;
