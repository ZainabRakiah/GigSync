/* ==========================================================================
   GigSync — Vercel Serverless Function Handler (/api/*)
   Complete REST API Gateway Parity with Local Node Backend
   ========================================================================== */

const DB = require('../backend/database');
const FirebaseSync = require('../backend/firebase');
const { aiAgent, AI_TOOLS, sessionManager } = require('../backend/ai_agent');
const { resolveAiCaller, getAuthSession } = require('../backend/caller_identity');
const { authorizeJobMutation, workerForSession, samePhone } = require('../backend/job_policy');
const { resolveTtsLanguage } = require('../backend/tts');

function parseBody(req) {
    return new Promise((resolve) => {
        if (req.body && typeof req.body === 'object') return resolve(req.body);
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); } catch (e) { resolve({}); }
        });
    });
}

function sendJSON(res, data, statusCode = 200) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (typeof res.status === 'function' && typeof res.json === 'function') {
        return res.status(statusCode).json(data);
    }
    res.statusCode = statusCode;
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

module.exports = async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (typeof res.status === 'function') return res.status(204).end();
        res.statusCode = 204;
        return res.end();
    }

    const host = req.headers.host || 'localhost';
    const url = new URL(req.url, `http://${host}`);
    const pathname = url.pathname;
    const query = Object.fromEntries(url.searchParams.entries());
    const params = url.searchParams;
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

    // Vercel functions do not share a filesystem. Hydrate the local query cache
    // from the authenticated Firestore source before any CRUD or availability
    // decision is made. A short in-instance cache prevents repeat reads during
    // a normal voice conversation.
    if (process.env.VERCEL && !pathname.endsWith('/events')) {
        try { await DB.hydrateFromFirestore(); }
        catch (err) { console.error('[Firestore Hydration Error]', err.message); }
    }

    /* ----------------------------------------------------------------------
       0. LIVE CHANGE STREAM (Server-Sent Events)
       ---------------------------------------------------------------------- */
    if (pathname.endsWith('/events') && req.method === 'GET') {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (typeof res.status === 'function') res.status(200);
        else res.statusCode = 200;
        res.write('event: ready\ndata: {"connected":true}\n\n');
        return res.end();
    }

    /* ----------------------------------------------------------------------
       1. AUTHENTICATION REST API
       ---------------------------------------------------------------------- */

    // POST /api/auth/register
    if (pathname.endsWith('/auth/register') && req.method === 'POST') {
        const body = await parseBody(req);
        if (!body.name || !body.phone || !body.password || !body.role) {
            return sendJSON(res, { status: 'error', message: 'Name, mobile number, password, and role are required.' }, 400);
        }

        const cleanPhone = body.phone.replace(/\D/g, '');
        const existing = DB.getUserByPhone(cleanPhone);
        if (existing) {
            return sendJSON(res, { status: 'error', message: 'An account with this phone number already exists. Please log in.' }, 409);
        }

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

        try {
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
        } catch (err) {
            if (err.message && err.message.includes('UNIQUE')) {
                return sendJSON(res, { status: 'error', message: 'An account with this phone number already exists.' }, 409);
            }
            console.error('[Vercel Register Error]', err);
            return sendJSON(res, { status: 'error', message: 'Could not create the account. Please try again.' }, 500);
        }
    }

    // POST /api/auth/login
    if (pathname.endsWith('/auth/login') && req.method === 'POST') {
        const body = await parseBody(req);
        if (!body.phone || !body.password) {
            return sendJSON(res, { status: 'error', message: 'Mobile number and password are required.' }, 400);
        }

        const cleanPhone = (body.phone || '').replace(/\D/g, '');
        let session = null;
        try {
            session = DB.authenticateUser(cleanPhone, body.password);
        } catch (err) {
            console.error('[Vercel Login Error]', err);
            return sendJSON(res, { status: 'error', message: 'Sign-in is temporarily unavailable. Please try again.' }, 503);
        }

        if (!session) {
            return sendJSON(res, { status: 'error', message: 'Invalid mobile number or password.' }, 401);
        }

        return sendJSON(res, { status: 'success', message: 'Login successful.', ...session });
    }

    // GET /api/auth/me
    if (pathname.endsWith('/auth/me') && req.method === 'GET') {
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
    if (pathname.endsWith('/auth/logout') && req.method === 'POST') {
        if (token) {
            try { DB.deleteSession(token); } catch (_) {}
        }
        return sendJSON(res, { status: 'success', message: 'Logged out successfully.' });
    }

    /* ----------------------------------------------------------------------
       2. WORKERS REST API
       ---------------------------------------------------------------------- */

    // GET /api/workers/available?date=YYYY-MM-DD&city=X
    if (pathname.endsWith('/workers/available') && req.method === 'GET') {
        const date = params.get('date');
        const city = params.get('city') || null;
        const requestedTime = params.get('requested_time') || params.get('time') || null;
        const requestedEndTime = params.get('requested_end_time') || params.get('end_time') || null;
        if (!date) return sendJSON(res, { status: 'error', message: 'date parameter required.' }, 400);
        try {
            const workers = DB.getWorkersAvailableOnDate(date, city, requestedTime, requestedEndTime);
            return sendJSON(res, { status: 'success', workers });
        } catch (err) {
            console.error('[Vercel Workers Available Error]', err);
            return sendJSON(res, { status: 'error', message: 'Could not load available workers.' }, 500);
        }
    }

    // GET /api/workers
    if (pathname.endsWith('/workers') && req.method === 'GET') {
        const city = params.get('city') || null;
        const service = params.get('service') || null;
        const available = params.get('available');
        const minRating = params.get('minRating');

        let workers = [];
        try {
            workers = DB.getAllWorkers({
                city,
                service,
                minRating,
                isAvailable: available !== null && available !== undefined ? available === 'true' : undefined
            });
        } catch (err) {
            console.error('[Vercel Workers Error]', err);
            return sendJSON(res, { status: 'error', message: 'Could not load specialists right now.' }, 503);
        }

        return sendJSON(res, { status: 'success', count: workers.length, workers });
    }

    // GET /api/workers/:id/schedule & GET /api/workers/me/schedule
    const schedMatch = pathname.match(/\/workers\/(me|\d+)\/schedule/);
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
    const earnMatch = pathname.match(/\/workers\/(\d+)\/earnings/);
    if (earnMatch && req.method === 'GET') {
        const workerId = Number(earnMatch[1]);
        const earnings = DB.getWorkerEarnings(workerId);
        return sendJSON(res, { status: 'success', workerId, earnings });
    }

    // GET /api/workers/me/availability/conflicts or GET /api/workers/:id/availability/conflicts
    const conflictRouteMatch = pathname.match(/\/workers\/(me|\d+)\/availability\/conflicts/);
    if (conflictRouteMatch && req.method === 'GET') {
        const access = authorizedWorkerRoute(req, conflictRouteMatch[1]);
        if (access.error) return sendJSON(res, { status: 'error', message: access.error.message }, access.error.code);
        const { worker } = access;

        let proposedSlots = [];
        try { proposedSlots = JSON.parse(params.get('slots') || '[]'); } catch (_) {}

        const conflicts = DB.getConflictingJobsForAvailabilityChange(worker.id, proposedSlots);
        return sendJSON(res, { status: 'success', conflicts });
    }

    // POST /api/workers/me/availability/resolve or POST /api/workers/:id/availability/resolve
    const resolveRouteMatch = pathname.match(/\/workers\/(me|\d+)\/availability\/resolve/);
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

    // POST or PATCH /api/workers/me/availability or /api/workers/:id/availability
    const availRouteMatch = pathname.match(/\/workers\/(me|\d+)\/availability/);
    if (availRouteMatch && (req.method === 'PATCH' || req.method === 'POST')) {
        const access = authorizedWorkerRoute(req, availRouteMatch[1]);
        if (access.error) return sendJSON(res, { status: 'error', message: access.error.message }, access.error.code);
        const { worker } = access;
        const body = await parseBody(req);

        if (body.is_available !== undefined) {
            DB.updateWorkerAvailabilityStatus(worker.id, body.is_available);
        }

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

    // GET /api/workers/:id
    const workerMatch = pathname.match(/\/workers\/(\d+)$/);
    if (workerMatch && req.method === 'GET') {
        const workerId = Number(workerMatch[1]);
        const worker = DB.getWorkerById(workerId);
        if (!worker) return sendJSON(res, { status: 'error', message: 'Worker not found.' }, 404);
        return sendJSON(res, { status: 'success', worker });
    }

    // PATCH /api/workers/me/profile
    if (pathname.endsWith('/workers/me/profile') && req.method === 'PATCH') {
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
    if (pathname.endsWith('/customers/me/profile') && req.method === 'PATCH') {
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

        return sendJSON(res, { status: 'success', message: 'Profile updated.', customer });
    }

    /* ----------------------------------------------------------------------
       3. JOBS & BOOKINGS REST API
       ---------------------------------------------------------------------- */

    // GET /api/jobs
    if (pathname.endsWith('/jobs') && req.method === 'GET') {
        const session = getAuthSession(req);
        const status = query.status || null;
        const city = query.city || null;
        const phone = query.phone || query.customer_phone || null;
        const workerPhone = query.worker_phone || null;

        let jobs = [];
        let availableOpportunities = [];
        let workerCancelledJobs = [];

        try {
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
                jobs = [];
            }
        } catch (err) {
            console.error('[Vercel Jobs Error]', err);
            return sendJSON(res, { status: 'error', message: 'Could not load jobs right now.' }, 503);
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
    if (pathname.endsWith('/jobs') && req.method === 'POST') {
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
            console.error('[Vercel Create Job Error]', err);
            return sendJSON(res, { status: 'error', message: 'The job could not be saved. Please try again.' }, 500);
        }
    }

    // GET /api/jobs/:id
    const jobUpdateMatch = pathname.match(/\/jobs\/([A-Za-z0-9-]+)$/);
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
    const jobReviewMatch = pathname.match(/\/jobs\/([A-Za-z0-9-]+)\/review$/);
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

    // Firebase configuration and bulk migration are privileged operations.
    // They must never be callable anonymously from the public website.
    const isFirebaseAdmin = () => {
        const session = getAuthSession(req);
        return Boolean(session && session.role === 'admin');
    };

    // GET /api/firebase/config
    if (pathname.endsWith('/firebase/config') && req.method === 'GET') {
        if (!isFirebaseAdmin()) return sendJSON(res, { status: 'error', message: 'Administrator authorization required.' }, 403);
        return sendJSON(res, { status: 'success', config: FirebaseSync.getConfig() });
    }

    // POST /api/firebase/config
    if (pathname.endsWith('/firebase/config') && req.method === 'POST') {
        if (!isFirebaseAdmin()) return sendJSON(res, { status: 'error', message: 'Administrator authorization required.' }, 403);
        const body = await parseBody(req);
        const updated = FirebaseSync.saveConfig(body);
        return sendJSON(res, { status: 'success', message: 'Firebase config updated.', config: updated });
    }

    // POST /api/firebase/sync
    if (pathname.endsWith('/firebase/sync') && req.method === 'POST') {
        if (!isFirebaseAdmin()) return sendJSON(res, { status: 'error', message: 'Administrator authorization required.' }, 403);
        const syncResult = await DB.triggerFullFirebaseSync();
        return sendJSON(res, {
            status: 'success',
            message: 'All local workers and jobs synchronized to Cloud Firestore collections.',
            ...syncResult
        });
    }

    // POST /api/admin/clear-data
    if (pathname.endsWith('/admin/clear-data') && req.method === 'POST') {
        try {
            const session = getAuthSession(req);
            const body = await parseBody(req);
            const configuredSecret = (process.env.ADMIN_SECRET_KEY || '').trim();
            const suppliedSecret = String(body.adminSecret || body.admin_secret || '').trim();
            if (!configuredSecret) return sendJSON(res, { status: 'error', message: 'Admin reset is not configured. Set ADMIN_SECRET_KEY in the server environment.' }, 503);
            if (!session || session.role !== 'admin') return sendJSON(res, { status: 'error', message: 'Administrator login is required.' }, 403);
            if (!suppliedSecret || suppliedSecret !== configuredSecret) return sendJSON(res, { status: 'error', message: 'Invalid administrator security key.' }, 403);
            const clearRes = DB.clearAllApplicationData();
            return sendJSON(res, { status: 'success', message: 'Clean production data reset complete. Database and Firestore cleared.', ...clearRes });
        } catch (err) {
            console.error('[Vercel Clear Data Error]', err);
            return sendJSON(res, { status: 'error', message: 'Could not clear data.' }, 500);
        }
    }

    /* ----------------------------------------------------------------------
       5. AI VOICE & CONVERSATIONAL GATEWAY
       ---------------------------------------------------------------------- */

    // GET /api/call-logs
    if (pathname.endsWith('/call-logs') && req.method === 'GET') {
        let callLogs = [];
        try {
            callLogs = DB.getAllCallLogs();
        } catch (err) {
            console.error('[Vercel Call Logs Error]', err);
            return sendJSON(res, { status: 'error', message: 'Could not load call logs right now.' }, 503);
        }
        return sendJSON(res, { status: 'success', count: callLogs.length, callLogs });
    }

    // GET /api/ai/caller?phone=XXXXXXXXXX
    if (pathname.endsWith('/ai/caller') && req.method === 'GET') {
        const session = getAuthSession(req);
        const identity = resolveAiCaller(session, { callerPhone: params.get('phone') || '' });
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
    if (pathname.endsWith('/ai/reset-session') && req.method === 'POST') {
        const body = await parseBody(req);
        if (body && body.sessionId) {
            if (sessionManager && sessionManager.resetSession) {
                sessionManager.resetSession(body.sessionId);
            }
        }
        return sendJSON(res, { status: 'success', message: 'Voice session reset.' });
    }

    // POST /api/ai/voice-call & POST /api/ai/chat
    if ((pathname.endsWith('/ai/voice-call') || pathname.endsWith('/ai/chat')) && req.method === 'POST') {
        const body = await parseBody(req);
        const isVoice = pathname.endsWith('/ai/voice-call') || body.isVoiceCall === true || body.portal === 'terminal';
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
                sessionId: body.sessionId || identity.callerPhone,
                callerPhone: identity.callerPhone,
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
            console.error('[Vercel AI Error]', err);
            return sendJSON(res, { status: 'error', message: 'AI Voice Agent processing error', error: err.message }, 500);
        }
    }

    // GET & POST /api/ai/tts
    if (pathname.endsWith('/ai/tts') && (req.method === 'GET' || req.method === 'POST')) {
        let text = '';
        let lang = 'en-IN';
        if (req.method === 'GET') {
            text = params.get('text') || '';
            lang = params.get('lang') || 'en-IN';
        } else {
            const body = await parseBody(req);
            text = body.text || '';
            lang = body.lang || 'en-IN';
        }

        if (!text) {
            return sendJSON(res, { status: 'error', message: 'Text is required for TTS' }, 400);
        }

        const targetLang = resolveTtsLanguage(text, lang);
        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text.slice(0, 200))}&tl=${targetLang}&client=tw-ob`;

        try {
            const https = require('node:https');
            return new Promise((resolve) => {
                https.get(ttsUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (ttsRes) => {
                    res.setHeader('Content-Type', 'audio/mpeg');
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    res.setHeader('Cache-Control', 'public, max-age=86400');
                    ttsRes.pipe(res);
                    ttsRes.on('end', () => resolve());
                }).on('error', (err) => {
                    sendJSON(res, { status: 'error', message: 'TTS error', error: err.message }, 500);
                    resolve();
                });
            });
        } catch (err) {
            return sendJSON(res, { status: 'error', message: 'TTS error', error: err.message }, 500);
        }
    }

    // Default Fallback
    return sendJSON(res, { status: 'ok', message: 'GigSync Serverless API Gateway Active' });
};
