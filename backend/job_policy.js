'use strict';

const DB = require('./database');

const ACTIVE_STATUSES = new Set(['Requested', 'Confirmed', 'Assigned', 'Accepted', 'On the Way', 'In Progress']);
const VALID_STATUSES = new Set([
    'Requested', 'Confirmed', 'Assigned', 'Accepted', 'On the Way',
    'In Progress', 'Completed', 'Cancelled', 'Cancelled (Worker)'
]);

function cleanPhone(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.length > 10 ? digits.slice(-10) : digits;
}

function samePhone(a, b) {
    const left = cleanPhone(a);
    const right = cleanPhone(b);
    return left.length === 10 && left === right;
}

function workerForSession(session) {
    if (!session || session.role !== 'worker') return null;
    return DB.getWorkerByUserId(session.user_id) || DB.getWorkerByPhone(session.phone);
}

/**
 * Decide whether an authenticated actor may perform a booking mutation.
 * The returned worker is the only worker identity the route may persist.
 */
function authorizeJobMutation(job, session, nextStatus) {
    if (!job) return { ok: false, code: 404, message: 'Job not found.' };
    if (!session) return { ok: false, code: 401, message: 'Authentication is required to change a booking.' };

    const status = String(nextStatus || '').trim();
    if (!VALID_STATUSES.has(status)) {
        return { ok: false, code: 400, message: 'Unsupported booking status.' };
    }

    if (session.role === 'admin') return { ok: true, worker: null };

    if (session.role === 'customer') {
        const ownsJob = samePhone(job.customer_phone, session.phone)
            || (job.customer_id !== null && String(job.customer_id) === String(session.user_id));
        if (!ownsJob) return { ok: false, code: 403, message: 'You can only manage your own bookings.' };
        if (status !== 'Cancelled') {
            return { ok: false, code: 403, message: 'Customers can only cancel an active booking.' };
        }
        if (!ACTIVE_STATUSES.has(job.status)) {
            return { ok: false, code: 409, message: 'This booking is already closed.' };
        }
        return { ok: true, worker: null };
    }

    if (session.role !== 'worker') {
        return { ok: false, code: 403, message: 'A customer, worker, or administrator session is required.' };
    }

    const worker = workerForSession(session);
    if (!worker) return { ok: false, code: 403, message: 'Worker profile not found.' };
    const assignedToWorker = Number(job.worker_id) === Number(worker.id) || samePhone(job.worker_phone, worker.phone);
    const canClaimBroadcast = !job.worker_id && !job.worker_phone && job.status === 'Requested'
        && (!job.city || !worker.city || String(job.city).toLowerCase() === String(worker.city).toLowerCase());

    if (!assignedToWorker && !canClaimBroadcast) {
        return { ok: false, code: 403, message: 'This booking is not assigned to your worker account.' };
    }

    const allowed = {
        Requested: new Set(['Confirmed', 'Accepted', 'Cancelled', 'Cancelled (Worker)', 'In Progress', 'Completed']),
        Confirmed: new Set(['Accepted', 'On the Way', 'In Progress', 'Completed', 'Cancelled', 'Cancelled (Worker)']),
        Assigned: new Set(['Accepted', 'On the Way', 'In Progress', 'Completed', 'Cancelled', 'Cancelled (Worker)']),
        Accepted: new Set(['On the Way', 'In Progress', 'Completed', 'Cancelled', 'Cancelled (Worker)']),
        'On the Way': new Set(['In Progress', 'Completed', 'Cancelled', 'Cancelled (Worker)']),
        'In Progress': new Set(['Completed', 'Cancelled', 'Cancelled (Worker)'])
    };
    if (job.status === status) return { ok: true, worker };
    if (!allowed[job.status] || !allowed[job.status].has(status)) {
        return { ok: false, code: 409, message: `A ${job.status} booking cannot be changed directly to ${status}.` };
    }

    return { ok: true, worker };
}

module.exports = { ACTIVE_STATUSES, VALID_STATUSES, cleanPhone, samePhone, workerForSession, authorizeJobMutation };
