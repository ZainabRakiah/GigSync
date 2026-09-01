/* ==========================================================================
   GigSync — Context-Aware & Database-First AI Voice Agent Engine
   Unified Google Gemini API Brain · Verified Real Database Tools
   ========================================================================== */

const fs = require('node:fs');
const path = require('node:path');

// Auto-load .env if present (strictly server-side, never exposed to client)
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    try {
        const envContent = fs.readFileSync(envPath, 'utf8');
        for (const line of envContent.split('\n')) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                const [k, ...v] = trimmed.split('=');
                const key = k.trim();
                const val = v.join('=').trim().replace(/^["']|["']$/g, '');
                if (!process.env[key]) {
                    process.env[key] = val;
                }
            }
        }
    } catch(e){}
}

const { GoogleGenAI } = require('@google/genai');
const DB = require('./database');
const { translateResponseIfRequired } = require('./translation');

// ======================================================================
// 0. SHARED HELPERS FOR REAL-DATA TOOLS
// ======================================================================

// Resolve a worker strictly from the verified caller phone. Never guesses.
function resolveWorker(phone) {
    const clean = (phone || '').replace(/\D/g, '');
    if (!clean) return { clean: '', worker: null };
    return { clean, worker: DB.getWorkerByPhone(clean) || null };
}

// Standard "this caller has no worker record" answer so the AI can be honest
// instead of inventing a profile.
function notRegistered(clean) {
    return {
        status: 'not_registered',
        dataAvailable: false,
        workerPhone: clean,
        message: `No worker account is registered for ${clean || 'this caller'} in the GigSync database.`
    };
}

const WORKER_OPEN_STATUSES = ['Requested', 'Accepted', 'Confirmed', 'On the Way', 'In Progress'];

// Every job row belonging to this worker, newest first.
function jobsForWorker(clean, workerId) {
    return DB.getAllJobs().filter(j => {
        const jp = (j.worker_phone || '').replace(/\D/g, '');
        return (jp && jp === clean) || (workerId && Number(j.worker_id) === Number(workerId));
    });
}

// The database layer returns a `firebaseSync` promise for write operations so the
// caller can find out whether the Firestore mirror actually accepted the write.
// Nothing here ever claims success on the AI's behalf.
async function awaitFirebase(dbResult) {
    if (!dbResult || !dbResult.firebaseSync) {
        return { ok: null, message: 'Firebase mirror was not attempted for this operation.' };
    }
    try {
        const out = await dbResult.firebaseSync;
        return out || { ok: null, message: 'Firebase mirror returned no result.' };
    } catch (err) {
        return { ok: false, message: `Firebase mirror failed: ${err.message}` };
    }
}

// 1. Definition of Real Database Tools (No Assumptions, No Fabricated Records)
const AI_TOOLS = {
    // 0. Simple Unified Worker Registration & Availability Upsert
    async registerOrUpdateWorker({ name, phone, job_role, trade, availability_date, date, start_time, startTime, end_time, endTime, pattern = 'once', daysOfWeek = [], rangeStart = null, rangeEnd = null, city = 'Ramanagara', password = null }) {
        const cleanPhone = (phone || '').replace(/\D/g, '');
        if (cleanPhone.length !== 10) {
            return { status: 'error', persisted: false, message: 'A valid 10-digit phone number is required.' };
        }
        const effectiveTrade = job_role || trade || 'Skilled Specialist';
        const effectiveDate = availability_date || date || 'Tomorrow';
        const effectiveStart = start_time || startTime || '09:00 AM';
        const effectiveEnd = end_time || endTime || '05:00 PM';

        const res = DB.registerOrUpdateWorker({
            name: name || 'Worker',
            phone: cleanPhone,
            job_role: effectiveTrade,
            availability_date: effectiveDate,
            start_time: effectiveStart,
            end_time: effectiveEnd,
            pattern,
            daysOfWeek,
            rangeStart: rangeStart || effectiveDate,
            rangeEnd,
            city,
            password
        });

        return {
            status: res.persisted ? 'success' : 'error',
            persisted: res.persisted,
            worker: res.worker,
            availability: res.availability
        };
    },

    // 1. Register or Update Worker Profile in Verified Database & Firebase
    async registerWorkerProfile({ name, phone, trade, city = 'Ramanagara', area = 'Town', tools = 'Standard tool kit', price = 300, experienceYears = 2, confirmed = false, password = null }) {
        const cleanPhone = (phone || '').replace(/\D/g, '');
        if (cleanPhone.length !== 10) {
            return {
                status: 'error',
                persisted: false,
                message: 'A valid 10-digit phone number is required before a worker record can be created. Ask the caller: "What is your phone number?"'
            };
        }
        if (!name || String(name).trim().length < 2 || ['worker', 'user', 'caller'].includes(String(name).toLowerCase())) {
            return { status: 'error', persisted: false, message: 'A worker name is required. Ask the caller: "What is your name?"' };
        }
        if (!trade || ['skilled specialist', 'general helper', 'specialist', 'worker', 'general labour'].includes(String(trade).toLowerCase().trim())) {
            return { status: 'error', persisted: false, message: 'A specific profession/trade (e.g. Electrician, Plumber, Carpenter, Mechanic) is required. Ask the caller: "What type of work do you do?"' };
        }

        if (!confirmed) {
            return {
                status: 'confirmation_required',
                persisted: false,
                pendingRegistration: { name: name.trim(), phone: cleanPhone, trade: trade.trim(), city },
                message: `NOT SAVED YET. Ask the caller to confirm registration: "Got it. You are ${name.trim()}, an ${trade.trim()}. Would you like me to register you as a GigSync worker?" If they say yes, call registerWorkerProfile again with confirmed: true.`
            };
        }

        const existingBefore = DB.getWorkerByPhone(cleanPhone);

        const res = DB.registerWorkerProfile({
            name: name.trim(),
            phone: cleanPhone,
            trade: trade.trim(),
            city,
            area,
            tools,
            price: Number(price) || 300,
            experienceYears: Number(experienceYears) || 2,
            password
        });

        // Read back from SQLite. A returned object is not proof; a re-read is.
        const after = DB.getWorkerByPhone(cleanPhone);
        const persisted = Boolean(after && after.id);
        const firebase = await awaitFirebase(res);

        return {
            status: persisted ? 'success' : 'error',
            persisted,
            action: existingBefore ? 'WORKER_PROFILE_UPDATED' : 'WORKER_REGISTERED',
            wasExistingWorker: Boolean(existingBefore),
            workerId: after ? after.id : null,
            worker: after,
            firebase,
            // True only when BOTH the authoritative DB and the Firebase mirror confirmed.
            fullySynced: persisted && firebase.ok === true
        };
    },

    // 2. Worker Availability Update
    async updateWorkerAvailability({ workerPhone, trade = 'Skilled Specialist', date = 'Tomorrow', startTime, endTime, isAvailable = true, confirmed = false, pattern = 'once', daysOfWeek = [], rangeStart = null, rangeEnd = null }) {
        const { clean, worker } = resolveWorker(workerPhone);

        // An availability slot must belong to a real worker; otherwise it is an orphan record.
        if (!worker) {
            return {
                status: 'not_registered',
                persisted: false,
                workerPhone: clean,
                message: `No worker is registered for ${clean || 'this caller'}. Register the worker profile first (name, phone, profession), then set availability.`
            };
        }
        // Marking a whole day OFF needs no clock times — "I don't want to work tomorrow" is a
        // complete instruction. Reuse whatever hours are already stored for that day so the record
        // stays meaningful, and fall back to a full-day span when nothing is stored.
        let effectiveStart = startTime;
        let effectiveEnd = endTime;
        if (!isAvailable && (!startTime || !endTime)) {
            const existing = (DB.getWorkerAvailability(clean, date) || [])[0] || null;
            effectiveStart = startTime || (existing ? existing.start_time : '12:00 AM');
            effectiveEnd = endTime || (existing ? existing.end_time : '11:59 PM');
        }

        // Hours are never guessed for an AVAILABLE day — the AI must ask.
        if (!effectiveStart || !effectiveEnd) {
            return {
                status: 'error',
                persisted: false,
                message: 'Both a start time and an end time are required to mark the worker available. Ask the worker for the missing one — do not assume it.'
            };
        }

        // CONFIRMATION GATE. Nothing is written until the worker has agreed to these exact
        // details out loud. This is enforced here rather than only in the prompt because a
        // prompt rule is advisory — the model was observed saving a schedule change on the
        // worker's first sentence, without ever asking.
        if (!confirmed) {
            const summary = isAvailable
                ? `${pattern === 'weekly' && daysOfWeek.length ? `${date} on ${daysOfWeek.join(', ')}` : date}, ${effectiveStart} to ${effectiveEnd}`
                : `${date} as a day off`;
            return {
                status: 'confirmation_required',
                persisted: false,
                pendingChange: { date, startTime: effectiveStart, endTime: effectiveEnd, isAvailable: Boolean(isAvailable), pattern, daysOfWeek, rangeStart, rangeEnd },
                message: `NOT SAVED YET. Read these exact details back to the worker and ask them to confirm: ${summary}. If they say yes, call updateWorkerAvailability again with the same values and confirmed set to true. If they change any detail, use the new values and ask again.`
            };
        }

        const res = DB.setWorkerAvailabilitySlot({
            workerId: worker.id,
            workerPhone: clean,
            trade: worker.trade || trade,
            dateStr: date,
            startTime: effectiveStart,
            endTime: effectiveEnd,
            isAvailable: Boolean(isAvailable),
            notes: isAvailable ? '' : 'Worker marked this day as not working',
            pattern,
            daysOfWeek,
            rangeStart: rangeStart || date,
            rangeEnd
        });

        DB.updateWorkerAvailabilityStatus(worker.id, isAvailable);

        // Read back the stored slot for this exact date.
        const storedForDate = (DB.getWorkerAvailability(clean, date) || [])[0] || null;
        const persisted = Boolean(storedForDate)
            && storedForDate.start_time === effectiveStart
            && storedForDate.end_time === effectiveEnd
            && Boolean(storedForDate.is_available) === Boolean(isAvailable);
        const firebase = await awaitFirebase(res);

        return {
            status: persisted ? 'success' : 'error',
            persisted,
            action: isAvailable ? 'AVAILABILITY_UPDATED' : 'MARKED_NOT_WORKING',
            workerName: worker.name,
            workerPhone: clean,
            trade: worker.trade || trade,
            date,
            startTime: storedForDate ? storedForDate.start_time : effectiveStart,
            endTime: storedForDate ? storedForDate.end_time : effectiveEnd,
            hours: `${effectiveStart} – ${effectiveEnd}`,
            isAvailable: Boolean(isAvailable),
            firebase,
            fullySynced: persisted && firebase.ok === true
        };
    },

    // 3. Get Worker Schedule & Bookings for Given Date
    getWorkerSchedule({ workerPhone, date = 'Today' }) {
        const { clean, worker } = resolveWorker(workerPhone);
        if (!worker) return notRegistered(clean);

        const schedule = DB.getWorkerSchedule(clean);
        let activeJobs = jobsForWorker(clean, worker.id).filter(j => WORKER_OPEN_STATUSES.includes(j.status));

        if (date && date.toLowerCase() !== 'all') {
            activeJobs = activeJobs.filter(j => j.requested_date && j.requested_date.toLowerCase() === date.toLowerCase());
        }

        return {
            status: 'success',
            dataAvailable: true,
            workerName: worker.name,
            profession: worker.trade,
            isAvailableNow: schedule?.isAvailableNow || false,
            date,
            count: activeJobs.length,
            bookings: activeJobs,
            availabilitySlots: schedule?.availabilitySlots || []
        };
    },

    // 4. Get Next Upcoming Job for Worker
    getWorkerNextJob({ workerPhone }) {
        const { clean, worker } = resolveWorker(workerPhone);
        if (!worker) return notRegistered(clean);

        const jobs = jobsForWorker(clean, worker.id)
            .filter(j => WORKER_OPEN_STATUSES.includes(j.status))
            .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

        if (jobs.length === 0) {
            return {
                status: 'none',
                dataAvailable: true,
                workerName: worker.name,
                message: 'This worker has no upcoming or open jobs in the database.'
            };
        }

        const j = jobs[0];
        return {
            status: 'success',
            dataAvailable: true,
            workerName: worker.name,
            remainingOpenJobs: jobs.length,
            job: {
                jobId: j.id,
                status: j.status,
                customerName: j.customer_name,
                service: j.service,
                problem: j.problem_description,
                location: j.location,
                city: j.city,
                requestedDate: j.requested_date,
                requestedTime: j.requested_time,
                budget: j.budget
            }
        };
    },

    // 5. Update Job Status by Worker (Arrived, Completed, Cancelled)
    updateJobStatusByWorker({ workerPhone, jobId, status = 'Completed' }) {
        const { clean, worker } = resolveWorker(workerPhone);
        if (!worker) return notRegistered(clean);

        const openJobs = jobsForWorker(clean, worker.id).filter(j => WORKER_OPEN_STATUSES.includes(j.status));

        let targetJob = null;
        if (jobId) {
            targetJob = jobsForWorker(clean, worker.id)
                .find(j => String(j.id).toLowerCase() === String(jobId).toLowerCase());
            if (!targetJob) {
                return {
                    status: 'error',
                    persisted: false,
                    message: `Job ${jobId} does not belong to this worker or does not exist.`
                };
            }
        } else if (openJobs.length === 1) {
            targetJob = openJobs[0];
        } else if (openJobs.length > 1) {
            // More than one candidate: ask the worker which one. Never pick for them.
            return {
                status: 'needs_disambiguation',
                persisted: false,
                message: 'This worker has more than one open job. Ask which job before changing any status.',
                choices: openJobs.map(j => ({
                    jobId: j.id, customerName: j.customer_name, service: j.service,
                    location: j.location, requestedDate: j.requested_date,
                    requestedTime: j.requested_time, status: j.status
                }))
            };
        }

        if (!targetJob) {
            return {
                status: 'none',
                persisted: false,
                message: 'This worker has no open job in the database to update.'
            };
        }

        DB.updateJobStatus(targetJob.id, status);

        // Read back — only a re-read proves the status actually changed.
        const after = DB.getJobById(targetJob.id);
        const persisted = Boolean(after) && after.status === status;

        return {
            status: persisted ? 'success' : 'error',
            persisted,
            action: 'JOB_STATUS_UPDATED',
            jobId: targetJob.id,
            requestedStatus: status,
            storedStatus: after ? after.status : null,
            job: after
        };
    },

    // 6. Get Worker Earnings
    getWorkerEarnings({ workerPhone }) {
        const { clean, worker } = resolveWorker(workerPhone);
        if (!worker) return notRegistered(clean);
        const earnings = DB.getWorkerEarnings(clean);
        const last = (earnings.completedJobs || [])[0] || null;
        return {
            status: 'success',
            dataAvailable: true,
            workerName: worker.name,
            workerPhone: clean,
            currency: 'INR',
            earnings,
            lastPayment: last ? {
                jobId: last.id,
                amount: last.final_price,
                service: last.service,
                customerName: last.customer_name,
                completedAt: last.completed_at,
                paymentStatus: last.payment_status,
                paymentMethod: last.payment_method
            } : null
        };
    },

    // 6a. Full worker profile as actually stored ("What details do you have about me?")
    getWorkerProfile({ workerPhone }) {
        const { clean, worker } = resolveWorker(workerPhone);
        if (!worker) return notRegistered(clean);
        const slots = DB.getWorkerAvailability(clean) || [];
        return {
            status: 'success',
            dataAvailable: true,
            profile: {
                workerId: worker.id,
                name: worker.name,
                phone: worker.phone,
                profession: worker.trade,
                service: worker.service,
                skills: worker.skills || null,
                tools: worker.tools || null,
                city: worker.city,
                area: worker.area,
                serviceAreas: worker.service_areas || null,
                experienceYears: worker.experience_years ?? null,
                startingPrice: worker.price,
                rating: worker.rating,
                jobsCompleted: worker.jobs_completed,
                isVerified: Boolean(worker.is_verified),
                onDutyNow: Boolean(worker.is_available)
            },
            availabilitySlots: slots.map(s => ({
                date: s.date_str, startTime: s.start_time, endTime: s.end_time,
                isAvailable: Boolean(s.is_available), updatedAt: s.updated_at
            }))
        };
    },

    // 6b. Availability for a date, or every stored slot ("Am I available today?")
    getWorkerAvailability({ workerPhone, date = null }) {
        const { clean, worker } = resolveWorker(workerPhone);
        if (!worker) return notRegistered(clean);
        const all = DB.getWorkerAvailability(clean) || [];
        const wanted = date && String(date).toLowerCase() !== 'all'
            ? all.filter(s => (s.date_str || '').toLowerCase() === String(date).toLowerCase())
            : all;

        return {
            status: 'success',
            dataAvailable: true,
            workerName: worker.name,
            profession: worker.trade,
            queriedDate: date || 'all',
            onDutyNow: Boolean(worker.is_available),
            matchCount: wanted.length,
            // Empty match means nothing is stored for that date — say so, do not guess.
            slots: wanted.map(s => ({
                date: s.date_str, startTime: s.start_time, endTime: s.end_time,
                isAvailable: Boolean(s.is_available), updatedAt: s.updated_at
            })),
            allStoredDates: [...new Set(all.map(s => s.date_str))]
        };
    },

    // 6c. Every booking/request for this worker, with status breakdown
    getWorkerBookings({ workerPhone, date = null, status = null }) {
        const { clean, worker } = resolveWorker(workerPhone);
        if (!worker) return notRegistered(clean);

        let jobs = jobsForWorker(clean, worker.id);
        if (date && String(date).toLowerCase() !== 'all') {
            const wantedDate = String(date).toLowerCase() === 'today' || String(date).toLowerCase() === 'tomorrow'
                ? String(date).toLowerCase() : String(date).toLowerCase();
            jobs = jobs.filter(j => {
                const stored = String(j.requested_date || '').toLowerCase();
                return stored === wantedDate || stored === String(date).toLowerCase();
            });
        }
        if (status && String(status).toLowerCase() !== 'all') {
            jobs = jobs.filter(j => (j.status || '').toLowerCase() === String(status).toLowerCase());
        }

        const byStatus = {};
        for (const j of jobs) byStatus[j.status] = (byStatus[j.status] || 0) + 1;

        return {
            status: 'success',
            dataAvailable: true,
            workerName: worker.name,
            queriedDate: date || 'all',
            queriedStatus: status || 'all',
            totalCount: jobs.length,
            countsByStatus: byStatus,
            openCount: jobs.filter(j => WORKER_OPEN_STATUSES.includes(j.status)).length,
            bookings: jobs.map(j => ({
                jobId: j.id,
                status: j.status,
                customerName: j.customer_name,
                service: j.service,
                problem: j.problem_description,
                location: j.location,
                city: j.city,
                requestedDate: j.requested_date,
                requestedTime: j.requested_time,
                budget: j.budget,
                createdAt: j.created_at
            }))
        };
    },

    // 6d. Completed job history incl. real ratings/reviews ("How was my last job?")
    getWorkerJobHistory({ workerPhone, limit = 10 }) {
        const { clean, worker } = resolveWorker(workerPhone);
        if (!worker) return notRegistered(clean);

        const completed = jobsForWorker(clean, worker.id)
            .filter(j => j.status === 'Completed')
            .sort((a, b) => String(b.completed_at || b.created_at).localeCompare(String(a.completed_at || a.created_at)));

        const shape = j => ({
            jobId: j.id,
            service: j.service,
            customerName: j.customer_name,
            location: j.location,
            completedAt: j.completed_at,
            amount: j.final_price,
            paymentStatus: j.payment_status,
            // null means the customer never left one — report it as unavailable.
            rating: j.rating ?? null,
            review: j.review || null
        });

        return {
            status: 'success',
            dataAvailable: true,
            workerName: worker.name,
            completedCount: completed.length,
            lastCompletedJob: completed.length ? shape(completed[0]) : null,
            history: completed.slice(0, Number(limit) || 10).map(shape)
        };
    },

    // 6e. "Is there anything I need to do today?" — one real snapshot of the day
    getWorkerDayBriefing({ workerPhone, date = 'Today' }) {
        const { clean, worker } = resolveWorker(workerPhone);
        if (!worker) return notRegistered(clean);

        const jobs = jobsForWorker(clean, worker.id);
        const forDate = jobs.filter(j => (j.requested_date || '').toLowerCase() === String(date).toLowerCase());
        const slots = (DB.getWorkerAvailability(clean) || [])
            .filter(s => (s.date_str || '').toLowerCase() === String(date).toLowerCase());

        return {
            status: 'success',
            dataAvailable: true,
            workerName: worker.name,
            profession: worker.trade,
            date,
            onDutyNow: Boolean(worker.is_available),
            availabilityForDate: slots.map(s => ({ startTime: s.start_time, endTime: s.end_time, isAvailable: Boolean(s.is_available) })),
            pendingRequests: forDate.filter(j => j.status === 'Requested').length,
            confirmedJobs: forDate.filter(j => ['Accepted', 'Confirmed'].includes(j.status)).length,
            inProgressJobs: forDate.filter(j => ['On the Way', 'In Progress'].includes(j.status)).length,
            completedToday: forDate.filter(j => j.status === 'Completed').length,
            cancelled: forDate.filter(j => j.status === 'Cancelled').length,
            jobs: forDate.map(j => ({
                jobId: j.id, status: j.status, customerName: j.customer_name,
                service: j.service, location: j.location, requestedTime: j.requested_time
            }))
        };
    },

    // 6f. Change stored profile fields for the verified worker (profession, price, ...)
    updateWorkerProfileField({ workerPhone, name, trade, price, city, area, skills, tools, confirmed = false }) {
        const { clean, worker } = resolveWorker(workerPhone);
        if (!worker) return notRegistered(clean);

        const updates = {};
        if (name) updates.name = name;
        if (trade) { updates.trade = trade; updates.service = String(trade).toLowerCase(); }
        if (price) updates.price = Number(price) || worker.price;
        if (city) updates.city = city;
        if (area) updates.area = area;
        if (skills) updates.skills = skills;
        if (tools) updates.tools = tools;

        if (Object.keys(updates).length === 0) {
            return { status: 'error', persisted: false, message: 'No profile field was supplied to change.' };
        }

        // Same confirmation gate as availability: a worker's profession, name or rate is not
        // changed until they have agreed to the specific change.
        if (!confirmed) {
            const summary = Object.entries(updates)
                .filter(([k]) => k !== 'service')
                .map(([k, v]) => `${k === 'trade' ? 'profession' : k} to ${v}`)
                .join(', ');
            return {
                status: 'confirmation_required',
                persisted: false,
                pendingChange: updates,
                message: `NOT SAVED YET. Ask the worker to confirm this change: ${summary}. If they say yes, call updateWorkerProfileField again with the same values and confirmed set to true.`
            };
        }

        DB.updateWorkerProfile(worker.id, updates);

        // Read back from the database — the only proof the write landed.
        const after = DB.getWorkerByPhone(clean);
        const persisted = Boolean(after) && Object.entries(updates).every(([k, v]) =>
            String(after[k] ?? '').toLowerCase() === String(v ?? '').toLowerCase());

        return {
            status: persisted ? 'success' : 'error',
            persisted,
            action: 'WORKER_PROFILE_UPDATED',
            changedFields: Object.keys(updates),
            workerId: worker.id,
            profile: after ? { name: after.name, profession: after.trade, price: after.price, city: after.city, area: after.area } : null
        };
    },

    // 6g. Worker marks a job finished ("I completed the job.")
    completeJob({ workerPhone, jobId = null }) {
        return AI_TOOLS.updateJobStatusByWorker({ workerPhone, jobId, status: 'Completed' });
    },

    // 6h. Get available unassigned job requests matching worker's trade and city
    getAvailableJobRequests({ workerPhone, trade = null, city = null }) {
        const { clean, worker } = resolveWorker(workerPhone);
        const targetCity = city || (worker ? worker.city : 'Ramanagara');
        const targetTrade = trade || (worker ? worker.trade : null);

        let jobs = DB.getAllJobs().filter(j => j.status === 'Requested' && (!j.worker_id && !j.worker_phone));
        if (targetCity) {
            jobs = jobs.filter(j => !j.city || j.city.toLowerCase() === targetCity.toLowerCase());
        }
        if (targetTrade) {
            const tradeNorm = targetTrade.toLowerCase();
            jobs = jobs.filter(j => j.service && (j.service.toLowerCase().includes(tradeNorm) || tradeNorm.includes(j.service.toLowerCase())));
        }

        return {
            status: 'success',
            dataAvailable: true,
            count: jobs.length,
            city: targetCity,
            trade: targetTrade,
            jobRequests: jobs.map(j => ({
                jobId: j.id,
                service: j.service,
                problem: j.problem_description,
                location: j.location,
                requestedDate: j.requested_date,
                requestedTime: j.requested_time,
                budget: j.budget
            }))
        };
    },

    // 6i. General GigSync Platform Information
    getGigSyncInformation({ topic = 'general' } = {}) {
        return {
            status: 'success',
            platform: 'GigSync Hyperlocal Marketplace',
            description: 'GigSync connects local customers with verified trade specialists across Karnataka Tier-2 and Tier-3 cities.',
            workerWorkflow: 'Workers register their trade, set daily working hours, receive customer service bookings, and track completed jobs and earnings.',
            customerWorkflow: 'Customers search for verified specialists in their town, view live availability, and request bookings directly or via voice.',
            availabilityPolicy: 'Workers can change or cancel their working hours anytime by speaking to the voice agent or using the worker portal.',
            paymentPolicy: 'Visiting fee starts at ₹300. Earnings are tracked immediately upon job completion.'
        };
    },

    // 7. Find Real Registered Workers from Database (Customer Tool)
    findWorkers({ service, trade, city = 'Ramanagara', requestedDate = null, requestedTime = null, requestedEndTime = null } = {}) {
        const targetTrade = trade || (service && service !== 'all' ? service : undefined);
        const workers = DB.getAllWorkers({
            service: targetTrade,
            city: city,
            isAvailable: true
        }) || [];
        const availableWorkers = getAvailableWorkersForSlot(workers, requestedDate, requestedTime, requestedEndTime);

        return {
            status: 'success',
            count: availableWorkers.length,
            workers: availableWorkers.map(w => ({
                id: w.id,
                name: w.name,
                phone: w.phone,
                trade: w.trade,
                service: w.service,
                rating: w.rating,
                distanceKm: w.km,
                startingPrice: `₹${w.price}`,
                isAvailable: Boolean(w.is_available),
                tools: w.tools,
                city: w.city,
                area: w.area
            }))
        };
    },

    // 8. Create Job in Real Database (Customer Tool)
    createJob({ customerPhone = '9876543210', customerName = 'Customer', service, problemDescription, location = 'Town Area', city = 'Ramanagara', requestedDate = 'Today', requestedTime = 'Immediate', requestedEndTime = null, budget = '₹300', workerId = null, workerName = null, workerPhone = null }) {
        let assignedWorker = null;
        if (workerId) {
            assignedWorker = DB.getWorkerById(workerId);
        } else if (workerPhone) {
            assignedWorker = DB.getWorkerByPhone(workerPhone);
        }

        // Schedule Conflict Prevention Check for Direct Worker Bookings
        if (assignedWorker && requestedDate && requestedTime && requestedDate !== 'Today' && requestedTime !== 'Immediate') {
            const conflict = DB.checkScheduleConflict(assignedWorker.id, requestedDate, requestedTime, requestedEndTime);
            if (conflict) {
                let reason = '';
                if (conflict === 'NotAvailable') reason = `${assignedWorker.name} has not set working availability for ${requestedDate}.`;
                else if (conflict === 'OutsideHours') reason = `Requested time (${requestedTime}) is outside ${assignedWorker.name}'s working hours on ${requestedDate}.`;
                else if (conflict === 'JobConflict') reason = `${assignedWorker.name} already has another booking around ${requestedTime} on ${requestedDate}.`;

                return {
                    status: 'conflict',
                    conflictType: conflict,
                    message: `${reason} Ask the customer if they would like to select an alternative time or broadcast to other nearby ${service || 'specialists'}.`,
                    assignedWorker
                };
            }
        }

        const newJob = DB.createJob({
            customer_phone: (customerPhone || '').replace(/\D/g, '') || '9876543210',
            customer_name: customerName || 'Customer',
            service: service || 'General Service',
            problem_description: problemDescription || `Service request for ${service}`,
            location: location || `${city} Town`,
            city: city || 'Ramanagara',
            requested_date: requestedDate,
            requested_time: requestedTime,
            requested_end_time: requestedEndTime,
            budget: budget || '₹300',
            worker_id: assignedWorker ? assignedWorker.id : null,
            worker_phone: assignedWorker ? assignedWorker.phone : (workerPhone || null),
            worker_name: assignedWorker ? assignedWorker.name : (workerName || null),
            status: assignedWorker ? 'Confirmed' : 'Requested'
        });

        return {
            status: 'success',
            action: 'JOB_CREATED',
            job: newJob,
            assignedWorker
        };
    },

    // 9. Get Customer Bookings (Customer Tool)
    getCustomerBookings({ customerPhone }) {
        const cleanPhone = (customerPhone || '').replace(/\D/g, '');
        const jobs = DB.getAllJobs().filter(j => j.customer_phone && j.customer_phone.replace(/\D/g, '') === cleanPhone);
        return {
            status: 'success',
            count: jobs.length,
            bookings: jobs
        };
    },

    // 10. Cancel Job (Customer Tool)
    cancelJob({ jobId, customerPhone }) {
        const job = DB.getJobById(jobId);
        if (!job) {
            return { status: 'error', message: `Job #${jobId} was not found.` };
        }
        if (customerPhone && job.customer_phone.replace(/\D/g, '') !== customerPhone.replace(/\D/g, '')) {
            return { status: 'error', message: `Unauthorized to cancel Job #${jobId}.` };
        }

        const updated = DB.updateJobStatus(jobId, 'Cancelled');
        return {
            status: 'success',
            action: 'JOB_CANCELLED',
            job: updated
        };
    },

    // 11. List Supported Services
    getServices() {
        return [
            'Electrical (Fan, wiring, switchboards)',
            'Plumbing (Pipe leaks, tap repairs, motor)',
            'Carpentry (Doors, locks, furniture)',
            'Two-Wheeler & Auto Mechanics',
            'AC & Fridge Tech',
            'Washing Machine & Appliance Repair',
            'Painting',
            'Home Cleaning',
            'Masonry & Construction',
            'Tailoring & Alterations',
            'Welding & Metalwork',
            'Driver Services',
            'TV & Electronics Repair',
            'Water Purifier & RO Service'
        ];
    }
};

// ======================================================================
// 1.1 GEMINI FUNCTION DECLARATIONS (OFFICIAL GOOGLE GENAI SCHEMA)
// ======================================================================
const GEMINI_TOOLS_DECLARATIONS = [
    {
        name: 'registerOrUpdateWorker',
        description: 'Save or update the worker profile and availability in the database and Firebase. Call this when Name, Job Role, Phone Number, Available Date, and Available Time (Start & End) are collected.',
        parameters: {
            type: 'OBJECT',
            properties: {
                name: { type: 'STRING', description: 'Worker name e.g. Rajesh' },
                phone: { type: 'STRING', description: '10-digit mobile number e.g. 7012280695' },
                job_role: { type: 'STRING', description: 'Trade profession e.g. Electrician, Plumber, Carpenter' },
                availability_date: { type: 'STRING', description: 'Date of availability e.g. Tomorrow, Today, Monday' },
                start_time: { type: 'STRING', description: 'Start time e.g. 09:00 AM' },
                end_time: { type: 'STRING', description: 'End time e.g. 05:00 PM' },
                city: { type: 'STRING', description: 'City/town e.g. Ramanagara' }
            },
            required: ['name', 'phone', 'job_role', 'availability_date', 'start_time', 'end_time']
        }
    },
    {
        name: 'registerWorkerProfile',
        description: 'Register a new worker profile. Both name, 10-digit phone number, and specific trade/profession are REQUIRED. NOTHING IS SAVED until you call this with confirmed:true, after reading back and confirming with the caller.',
        parameters: {
            type: 'OBJECT',
            properties: {
                name: { type: 'STRING', description: 'Full name of the worker e.g. Rajesh' },
                phone: { type: 'STRING', description: '10-digit mobile number e.g. 7012280695' },
                trade: { type: 'STRING', description: 'Specific trade profession e.g. Electrician, Plumber, Carpenter, Mechanic' },
                city: { type: 'STRING', description: 'City/town in Karnataka e.g. Ramanagara' },
                experienceYears: { type: 'NUMBER', description: 'Years of experience' },
                confirmed: { type: 'BOOLEAN', description: 'Set true ONLY after the caller confirmed. Leave false on first call.' }
            },
            required: ['name', 'phone', 'trade']
        }
    },
    {
        name: 'updateWorkerAvailability',
        description: 'Set the calling worker\'s working hours for one day, or save a recurring daily or weekly schedule. To set hours you MUST have both a start and an end time — ask the worker for whichever is missing instead of guessing. For weekly availability, also collect the weekday(s). To mark a day off, pass isAvailable:false and no times are needed ("I don\'t want to work tomorrow"). NOTHING IS SAVED until you call this a second time with confirmed:true, after the worker has agreed to the exact details.',
        parameters: {
            type: 'OBJECT',
            properties: {
                workerPhone: { type: 'STRING', description: 'Filled automatically from the verified caller. Do not ask for it.' },
                trade: { type: 'STRING', description: 'Trade e.g. Electrician. Optional — the stored profession is used when omitted.' },
                date: { type: 'STRING', description: 'Day label: Today, Tomorrow, or a weekday name' },
                startTime: { type: 'STRING', description: 'Start time e.g. 09:00 AM. Required when isAvailable is true.' },
                endTime: { type: 'STRING', description: 'End time e.g. 05:00 PM. Required when isAvailable is true.' },
                isAvailable: { type: 'BOOLEAN', description: 'True = working these hours. False = not working that day (no times required).' },
                pattern: { type: 'STRING', description: 'Schedule pattern: once, daily, or weekly' },
                daysOfWeek: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Weekly day numbers where 0=Sunday and 6=Saturday' },
                rangeStart: { type: 'STRING', description: 'Recurring schedule start date or date label' },
                rangeEnd: { type: 'STRING', description: 'Optional recurring schedule end date' },
                confirmed: { type: 'BOOLEAN', description: 'Set true ONLY after you read the exact day and hours back to the worker and they agreed. Leave false or omit on the first call — the tool will then tell you what to confirm.' }
            },
            required: ['date']
        }
    },
    {
        name: 'getWorkerSchedule',
        description: 'Jobs booked with the calling worker for a given day, plus their stored availability slots.',
        parameters: {
            type: 'OBJECT',
            properties: {
                workerPhone: { type: 'STRING', description: 'Worker phone number' },
                date: { type: 'STRING', description: 'Optional date to filter e.g. Today, Tomorrow' }
            }
        }
    },
    {
        name: 'getWorkerNextJob',
        description: 'Get the next upcoming job details (customer name, time, location, problem description) for the worker.',
        parameters: {
            type: 'OBJECT',
            properties: {
                workerPhone: { type: 'STRING', description: 'Worker phone number' }
            }
        }
    },
    {
        name: 'updateJobStatusByWorker',
        description: 'Update the job progress status by worker (e.g. Arrived / In Progress, Completed, Cancelled).',
        parameters: {
            type: 'OBJECT',
            properties: {
                workerPhone: { type: 'STRING', description: 'Worker phone number' },
                jobId: { type: 'STRING', description: 'Optional Job ID (e.g. GS-1048)' },
                status: { type: 'STRING', description: 'New status: "In Progress" (Arrived), "Completed" (Job finished), "Cancelled" (Cannot take job)' }
            },
            required: ['status']
        }
    },
    {
        name: 'getWorkerEarnings',
        description: 'Real earnings for the calling worker: today, this month, lifetime total, pending amount, number of completed jobs, and the most recent payment. Use for any money/payment/income question.',
        parameters: {
            type: 'OBJECT',
            properties: {
                workerPhone: { type: 'STRING', description: 'Filled automatically from the verified caller. Do not ask for it.' }
            }
        }
    },
    {
        name: 'getWorkerProfile',
        description: 'Read everything GigSync actually stores about the calling worker: name, phone, profession/trade, skills, tools, city, area, experience, starting price, rating, jobs completed, verification and duty status. Use for "what details do you have about me", "who am I registered as", "what is my rate", "what trade am I listed under".',
        parameters: {
            type: 'OBJECT',
            properties: {
                workerPhone: { type: 'STRING', description: 'Filled automatically from the verified caller. Do not ask for it.' }
            }
        }
    },
    {
        name: 'getWorkerAvailability',
        description: 'Read the calling worker\'s stored availability slots. Pass a date to check one day ("Today", "Tomorrow", a weekday) or omit it for every stored day. Use for "am I available today", "what is my availability tomorrow", "what are my working hours", "am I on duty".',
        parameters: {
            type: 'OBJECT',
            properties: {
                workerPhone: { type: 'STRING', description: 'Filled automatically from the verified caller. Do not ask for it.' },
                date: { type: 'STRING', description: 'Day label to check, e.g. Today, Tomorrow, Sunday. Omit for all stored days.' }
            }
        }
    },
    {
        name: 'getWorkerBookings',
        description: 'Read every booking and job request attached to the calling worker, with a count broken down by status. Optionally filter by date or status. Use for "has anyone booked me", "did anyone request me", "how many jobs do I have this week", "has my customer cancelled", "what bookings do I have", "do I have anything tomorrow".',
        parameters: {
            type: 'OBJECT',
            properties: {
                workerPhone: { type: 'STRING', description: 'Filled automatically from the verified caller. Do not ask for it.' },
                date: { type: 'STRING', description: 'Optional day label filter, e.g. Today, Tomorrow.' },
                status: { type: 'STRING', description: 'Optional status filter: Requested, Confirmed, Accepted, On the Way, In Progress, Completed, Cancelled.' }
            }
        }
    },
    {
        name: 'getWorkerJobHistory',
        description: 'Read the calling worker\'s completed job history including the real customer rating and written review for each job, the amount paid and the payment status. Use for "what jobs have I completed", "how was my last job", "what was my last payment", "what did customers say about me". If rating or review is null the customer never left one — say it is not available.',
        parameters: {
            type: 'OBJECT',
            properties: {
                workerPhone: { type: 'STRING', description: 'Filled automatically from the verified caller. Do not ask for it.' },
                limit: { type: 'NUMBER', description: 'How many past jobs to return. Default 10.' }
            }
        }
    },
    {
        name: 'getWorkerDayBriefing',
        description: 'One combined snapshot of a single day for the calling worker: the availability stored for that day plus counts of pending requests, confirmed jobs, jobs in progress, completed and cancelled jobs, with the job list. Use for open-ended questions like "is there anything I need to do today", "what does my day look like", "am I busy tomorrow", "what is my status".',
        parameters: {
            type: 'OBJECT',
            properties: {
                workerPhone: { type: 'STRING', description: 'Filled automatically from the verified caller. Do not ask for it.' },
                date: { type: 'STRING', description: 'Day label, e.g. Today or Tomorrow. Defaults to Today.' }
            }
        }
    },
    {
        name: 'updateWorkerProfileField',
        description: 'Change stored profile fields for the calling worker who already has an account: profession/trade, display name, starting price, city, area, skills or tools. Only pass the fields that are actually changing. NOTHING IS SAVED until you call this a second time with confirmed:true, after the worker has agreed to the change.',
        parameters: {
            type: 'OBJECT',
            properties: {
                workerPhone: { type: 'STRING', description: 'Filled automatically from the verified caller. Do not ask for it.' },
                name: { type: 'STRING', description: 'New display name' },
                trade: { type: 'STRING', description: 'New profession e.g. Plumber, Electrician, Carpenter, Mechanic' },
                price: { type: 'NUMBER', description: 'New starting price in rupees' },
                city: { type: 'STRING', description: 'New city' },
                area: { type: 'STRING', description: 'New area/neighbourhood' },
                skills: { type: 'STRING', description: 'Comma separated skills' },
                tools: { type: 'STRING', description: 'Comma separated tools owned' },
                confirmed: { type: 'BOOLEAN', description: 'Set true ONLY after you read the change back to the worker and they agreed. Leave false or omit on the first call.' }
            }
        }
    },
    {
        name: 'getServices',
        description: 'The list of service categories GigSync covers. Use when a caller asks what services the platform offers, or when a worker asks which trades they can be listed under.',
        parameters: { type: 'OBJECT', properties: {} }
    },
    {
        name: 'completeJob',
        description: 'Mark one of the calling worker\'s jobs as Completed. Use when the worker says the job is finished. If the worker has several open jobs the tool returns the list so you can ask which one — never guess.',
        parameters: {
            type: 'OBJECT',
            properties: {
                workerPhone: { type: 'STRING', description: 'Filled automatically from the verified caller. Do not ask for it.' },
                jobId: { type: 'STRING', description: 'Job ID such as GS-1048, when known.' }
            }
        }
    },
    {
        name: 'findWorkers',
        description: 'Find real registered and available trade workers from the GigSync database for a requested trade and city.',
        parameters: {
            type: 'OBJECT',
            properties: {
                service: { type: 'STRING', description: 'Trade or service category, e.g. Electrical, Plumbing, Carpentry, Mechanics, Painting' },
                city: { type: 'STRING', description: 'City name e.g. Ramanagara' },
                requestedDate: { type: 'STRING', description: 'Requested service date' },
                requestedTime: { type: 'STRING', description: 'Requested service time' },
                requestedEndTime: { type: 'STRING', description: 'Requested service end time if known' }
            },
            required: ['service']
        }
    },
    {
        name: 'createJob',
        description: 'Create a real customer job request or dispatch a booking to a registered worker in the database.',
        parameters: {
            type: 'OBJECT',
            properties: {
                service: { type: 'STRING', description: 'The service required e.g. Electrical, Plumbing' },
                problemDescription: { type: 'STRING', description: 'Brief description of the customer issue' },
                city: { type: 'STRING', description: 'Service city' },
                location: { type: 'STRING', description: 'Neighborhood or address' },
                requestedDate: { type: 'STRING', description: 'Requested service date' },
                requestedTime: { type: 'STRING', description: 'Requested time' },
                requestedEndTime: { type: 'STRING', description: 'Requested end time when the caller gives a time range' },
                budget: { type: 'STRING', description: 'Budget or fee' },
                workerId: { type: 'STRING', description: 'ID of worker if booking a specific worker' },
                workerName: { type: 'STRING', description: 'Name of worker if booking a specific worker' },
                workerPhone: { type: 'STRING', description: 'Phone of worker if booking a specific worker' }
            },
            required: ['service', 'city']
        }
    },
    {
        name: 'getCustomerBookings',
        description: 'Retrieve real active bookings and jobs for the customer.',
        parameters: {
            type: 'OBJECT',
            properties: {
                customerPhone: { type: 'STRING', description: 'Customer phone number' }
            }
        }
    },
    {
        name: 'cancelJob',
        description: 'Cancel an active job or booking in the database.',
        parameters: {
            type: 'OBJECT',
            properties: {
                jobId: { type: 'STRING', description: 'The Job ID to cancel' },
                customerPhone: { type: 'STRING', description: 'Customer phone for verification' }
            },
            required: ['jobId']
        }
    },
    {
        name: 'getAvailableJobRequests',
        description: 'Find unassigned, open customer job requests in the worker\'s city matching their trade. Use for "are there any jobs available", "any new jobs near me", "is anyone looking for an electrician", "show me available work".',
        parameters: {
            type: 'OBJECT',
            properties: {
                workerPhone: { type: 'STRING', description: 'Filled automatically from the verified caller. Do not ask for it.' },
                trade: { type: 'STRING', description: 'Trade e.g. Electrical. Optional.' },
                city: { type: 'STRING', description: 'City e.g. Ramanagara. Optional.' }
            }
        }
    },
    {
        name: 'getGigSyncInformation',
        description: 'Answer general questions about how GigSync works, how workers get paid, setting availability, or platform policies. Use when a caller asks "how does GigSync work", "how do I get paid", "can I change my hours later", "why don\'t I see jobs".',
        parameters: {
            type: 'OBJECT',
            properties: {
                topic: { type: 'STRING', description: 'The topic or question category' }
            }
        }
    }
];

// ======================================================================
// 1.2 UNIFIED GEMINI CONVERSATIONAL BRAIN
// ======================================================================
const GEMINI_MODEL_CHAIN = (() => {
    const preferred = (process.env.GEMINI_MODEL || '').trim();
    const chain = [
        // Stable Google Gemini API ids. The previous 3.x placeholders can
        // fail in production and force the English-only local fallback.
        'gemini-2.5-flash-lite',
        'gemini-2.5-flash'
    ];
    if (preferred) chain.unshift(preferred);
    return chain.filter((m, i) => chain.indexOf(m) === i);
})();

// Errors that mean "this model is busy / out of quota" — try the next model instead of
// silently dropping the caller into a scripted reply.
function isModelExhaustedError(err) {
    const blob = `${err && err.status ? err.status : ''} ${err && err.code ? err.code : ''} ${err && err.message ? err.message : err}`;
    return /\b(429|500|503)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|INTERNAL|quota|rate limit|overloaded|exceeded/i.test(blob);
}

// Tools that act on the caller's own worker record. The phone always comes from the
// verified session, never from anything the caller (or a mis-heard transcript) supplied.
const SELF_SCOPED_WORKER_TOOLS = new Set([
    'getWorkerProfile', 'getWorkerAvailability', 'getWorkerBookings', 'getWorkerJobHistory',
    'getWorkerDayBriefing', 'getWorkerSchedule', 'getWorkerNextJob', 'getWorkerEarnings',
    'updateWorkerAvailability', 'updateWorkerProfileField', 'updateJobStatusByWorker',
    'completeJob', 'registerWorkerProfile'
]);

// Turns a tool result into one honest operator-facing audit line. Writes report whether
// they actually persisted, and a broken Firebase mirror is named explicitly.
function describeToolOutcome(toolName, result) {
    if (!result || typeof result !== 'object') return `${toolName}: no result returned`;

    if (result.status === 'confirmation_required') {
        return `${toolName}: awaiting caller confirmation — nothing written`;
    }
    if (result.status === 'not_registered') {
        return `${toolName}: no worker account for ${result.workerPhone || 'this caller'}`;
    }
    if (result.status === 'needs_disambiguation') {
        return `${toolName}: asked the caller which job they meant`;
    }

    // Writes expose a persisted flag; reads do not.
    if (Object.prototype.hasOwnProperty.call(result, 'persisted')) {
        if (!result.persisted) {
            return `${toolName}: WRITE FAILED — ${result.message || 'the change did not persist'}`;
        }
        let line = `${toolName}: saved to the database`;
        if (result.firebase && result.firebase.ok === true) line += ', mirrored to Firebase';
        else if (result.firebase && result.firebase.ok === false) line += `, but the Firebase mirror FAILED — ${result.firebase.message}`;
        return line;
    }

    if (result.status === 'error') return `${toolName}: ${result.message || 'failed'}`;
    if (result.dataAvailable === false) return `${toolName}: no data available`;
    return `${toolName}: read real data`;
}

class GeminiConversationalBrain {
    constructor() {
        this.apiKey = process.env.GEMINI_API_KEY || '';
        this.client = this.apiKey ? new GoogleGenAI({ apiKey: this.apiKey }) : null;
        this.modelChain = GEMINI_MODEL_CHAIN;
        this.modelIndex = 0;          // sticky: stay on the last model that actually worked
        this.lastError = null;        // surfaced honestly instead of a generic menu reply
        this.lastModelUsed = null;
    }

    getClient() {
        const key = (process.env.GEMINI_API_KEY || '').trim();
        if (key && key !== 'your_gemini_api_key_here' && key.length > 10) {
            if (!this.client || this.apiKey !== key) {
                this.apiKey = key;
                this.client = new GoogleGenAI({ apiKey: key });
            }
            return this.client;
        }
        return null;
    }

    // Voice interaction must feel conversational.  Fall back to the local,
    // deterministic agent if Gemini cannot produce its first response quickly.
    async generateWithFallback(client, request) {
        let lastErr = null;
        // Keep the server-side brain inside a bounded call-turn budget. If
        // Gemini is unavailable, the deterministic database-first fallback
        // answers after the timeout instead of hanging indefinitely.
        // Give Gemini a realistic window to answer before using the
        // database-backed fallback. The environment variable may lower this
        // for testing, but production is capped at five seconds.
        const configuredTimeout = Number(process.env.AI_RESPONSE_TIMEOUT_MS);
        const timeoutMs = Math.min(Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 5000, 5000);

        for (let attempt = 0; attempt < 1; attempt++) {
            const idx = (this.modelIndex + attempt) % this.modelChain.length;
            const model = this.modelChain[idx];
            try {
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`Gemini API call timed out after ${timeoutMs}ms`)), timeoutMs)
                );
                const apiPromise = client.models.generateContent({ ...request, model });
                const response = await Promise.race([apiPromise, timeoutPromise]);

                if (idx !== this.modelIndex) {
                    this.modelIndex = idx;
                }
                this.lastModelUsed = model;
                this.lastError = null;
                return response;
            } catch (err) {
                lastErr = err;
                console.warn(`[Gemini Engine] Model '${model}' attempt failed or timed out (${err.message}).`);
            }
        }
        throw lastErr || new Error('Gemini API fallback timed out.');
    }

    async processTurn({ session, text }) {
        const client = this.getClient();
        if (!client) {
            this.lastError = 'GEMINI_API_KEY is not configured, so the AI brain cannot run.';
            return null;
        }

        const workerRecord = DB.getWorkerByPhone(session.callerPhone);
        const isVerifiedWorker = Boolean(workerRecord);
        const isWorkerCall = session.callerRole === 'worker' || isVerifiedWorker;

        const now = new Date();
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const tomorrow = new Date(now.getTime() + 86400000);

        const hasVerifiedPhone = session.callerPhone && /^[6-9]\d{9}$/.test(session.callerPhone);
        const draftState = session.workerDraft || (session.context && session.context.workerDraft) || {
            name: null,
            phone: hasVerifiedPhone ? session.callerPhone : null,
            occupation: null,
            availabilityDate: null,
            startTime: null,
            endTime: null
        };

        const activeCustomerJobs = session.callerPhone ? (DB.getJobsByCustomer(session.callerPhone) || []) : [];
        const activeWorkerJobs = (isVerifiedWorker && workerRecord) ? (DB.getJobsByWorker(workerRecord.phone) || []) : [];
        const availableJobRequests = (isVerifiedWorker && workerRecord) ? (DB.getAvailableJobsForWorker(workerRecord.trade, workerRecord.city) || []) : [];
        const allWorkersInCity = DB.getAllWorkers({ city: session.city || 'Ramanagara' }) || [];

        const identityBlock = `CALLER IDENTITY & DATABASE CONTEXT:
- Phone: ${hasVerifiedPhone ? session.callerPhone : (draftState.phone || '(unknown - ask for 10-digit mobile number)')}
- Role: ${isWorkerCall ? 'worker' : 'customer'}
- Registered GigSync worker account: ${isVerifiedWorker
    ? `YES — id ${workerRecord.id}, name "${workerRecord.name}", profession "${workerRecord.trade}", city ${workerRecord.city}`
    : 'NO — unregistered / new caller'}
- City: ${session.city || 'Ramanagara'}
- Today: ${dayNames[now.getDay()]}, ${now.toDateString()}. "Tomorrow" = ${dayNames[tomorrow.getDay()]}.

REAL DATABASE SNAPSHOT:
- Verified Workers in ${session.city || 'Ramanagara'}: ${allWorkersInCity.length} registered (${allWorkersInCity.map(w => `${w.name} [${w.trade}]`).slice(0, 5).join(', ')})
- Active Customer Bookings for Caller: ${JSON.stringify(activeCustomerJobs.map(j => ({ id: j.id, service: j.service, status: j.status, date: j.requested_date, time: j.requested_time })))}
- Worker Bookings for Caller: ${JSON.stringify(activeWorkerJobs.map(j => ({ id: j.id, service: j.service, status: j.status, date: j.requested_date, time: j.requested_time })))}
- Open Available Job Requests Near Worker: ${JSON.stringify(availableJobRequests.map(j => ({ id: j.id, service: j.service, location: j.location || j.city, date: j.requested_date, budget: j.budget })))}

WEBSITE & UI RECOMMENDATION CAPABILITY:
If the user or worker asks for UI changes, website customizations, layout adjustments, or new features, answer politely, explain what changes are needed, and provide concrete UI guidance.`;

        const workerBrief = `YOU ARE THE GIGSYNC WORKER VOICE AGENT — A NATURAL CONVERSATIONAL ASSISTANT.
Your job is to onboard workers, answer their questions using real tools, and manage their availability.

SLOT-FILLING & ONBOARDING SEQUENCE:
1. NEVER invent names or assume caller identity from previous sessions or web dashboard tokens.
2. If the user provides or corrects their name (e.g. "I am Asad", "My name is Rajesh"), immediately recognize Name = "Asad".
3. Required fields to onboard a new worker:
   - Name
   - Phone (10 digits starting with 6-9)
   - Occupation / Trade (e.g. Electrician, Plumber, Carpenter, Mechanic, Painter, Mason, Tailor, Welder)
   - Availability Date or recurring pattern (e.g. Tomorrow, Today, a weekday, daily, every Monday, or weekdays)
   - Working Hours (Start Time & End Time, e.g. 9 AM to 5 PM)
4. Extract all entities present in the user's message.
5. If fields are missing in Current Worker Draft, ask for the next missing field in strict natural order:
   Name -> Phone -> Occupation -> Date -> Working Hours.
   - If only Occupation was given ("I am electrician"): "Sure! What is your name?"
   - If Name was given ("I am Asad"): "Thank you, Asad. What is your 10-digit mobile number?"
   - If Phone was given ("7012280695"): "What type of work do you do?" (or ask for availability if trade is already known)
   - If Trade is known: "What day or repeating schedule are you available for? For example, tomorrow 9 AM to 5 PM, every Monday 9 AM to 5 PM, or daily 9 AM to 5 PM."
6. When all 5 fields are present, summarize and ask for confirmation before saving:
   "Got it. You are [Name], a/an [Occupation], available [Date or repeating schedule] from [StartTime] to [EndTime]. Shall I save these details?"
7. Only after the caller confirms (e.g. "Yes", "Save it", "Please save"), call registerWorkerProfile and updateWorkerAvailability with confirmed: true.

FOR RETURNING REGISTERED WORKERS:
- Answer questions on schedule (getWorkerSchedule), bookings (getWorkerBookings), next job (getWorkerNextJob), earnings (getWorkerEarnings), completed jobs (getWorkerJobHistory), and available job requests (getAvailableJobRequests).
- Update availability (updateWorkerAvailability) with confirmation before saving.

HONESTY RULES (these outrank sounding helpful):
- Never invent a name, hour, date, customer, amount, rating or job. If it is not in a tool result,
  you do not know it.
- If a tool returns dataAvailable:false, or an empty list, or a null field, SAY it is not available:
  "There's no availability saved for tomorrow yet." / "No customer has left a rating for that job."
- If a tool returns status:"not_registered", explain there is no worker account for their number and
  offer to register them — do not pretend to read their data.
- If a tool returns status:"needs_disambiguation", read out the choices and ask which job they mean.
- BEFORE any write (availability, profile change, registration, job status), read the exact details
  back and ask for a yes: "Got it — you're [Name], [an Electrician], available [Tomorrow] from [9 AM] to [5 PM]. Shall I save that?" Only skip that
  question if the worker has already said yes to those same details earlier in this call. Never save
  something they have not agreed to.
- If a tool returns status:"confirmation_required", NOTHING has been saved. Read the details in its
  message back to the worker and ask them to confirm. Do not tell them it is done. When they say yes,
  call the same tool again with the same values plus confirmed:true. If they change a detail, use the
  new value and confirm again.
- AFTER EVERY SUCCESSFUL WORKER REGISTRATION OR UPDATE, YOU MUST EXPLICITLY CONFIRM THE UPDATED DETAILS TO THE WORKER:
  * For new worker registration + availability: "Done. Your worker profile has been registered as an [trade] and your availability has been saved for [day] from [start] to [end]."
  * For availability change only: "Done. Your availability has been updated to [day], [start] to [end]."
  * For profession change: "Done. Your profession has been updated to [trade]."
- For writes, only say "Done" when the result has persisted:true. If persisted is false, say plainly
  that it did not save. If persisted is true but firebase.ok is false, their change IS saved — tell
  them it is saved. Do not read out technical causes; a worker on a phone call does not need to hear
  about Firestore, APIs, projects or cloud sync. Never say the words Firebase, Firestore, database,
  API, sync or server to a worker.
- Never guess missing details. No availability without both a start and an end time; ask for what is
  missing, and if the worker doesn't answer, ask once more.
- Tolerate speech-to-text noise, but confirm genuine ambiguity: "6 to 5" -> "Just to confirm, 6 AM to 5 PM?"
- Handle changes of mind mid-call: "Actually make it 10 to 6" replaces the number they just gave.
- Pass day labels ("Today", "Tomorrow", a weekday name) to tools, not calendar dates.

IF THE REQUEST IS UNCLEAR: ask ONE short clarifying question and keep the thread.
  "Can I change it?" -> "Sure. What would you like to change?"
  "Tomorrow." -> "Do you want to change your availability for tomorrow?"
  "Yes." -> "What hours would you like?"
This is a conversation, not a questionnaire. Use the earlier turns of this call to fill in the
subject the worker left out.

IF THE REQUEST HAS NOTHING TO DO WITH GIGSYNC: redirect politely, once —
  "I'm here to help with your GigSync work, bookings, availability and account. What would you like help with?"
Never dress up an unrelated answer as a GigSync answer.`;

        const customerBrief = `YOU ARE HELPING A CUSTOMER looking for a skilled worker.
- Searching for a trade ("I need an electrician tomorrow", "Nanage electrician beku") -> findWorkers.
  Never call updateWorkerAvailability for a customer.
- Booking a worker -> createJob, after confirming the details back to them.
- "What have I booked?" -> getCustomerBookings. "Cancel my booking" -> cancelJob.
- Available services -> getServices.
- Only describe workers, prices and slots that a tool actually returned. If nothing is available in
  their city for that day, say exactly that instead of inventing an option.`;

        const selectedLanguage = /^(KN|HN|EN)$/.test(session.language || '') ? session.language : 'EN';
        const languageInstruction = selectedLanguage === 'KN'
            ? `RESPONSE LANGUAGE: Kannada (KN). Understand the user's Kannada, Hindi, English, mixed language, and Romanized speech naturally. ALWAYS reply in natural Kannada using Kannada Unicode script. NEVER reply in Romanized Kannada or English unless the user explicitly asks for English. This applies to greetings, clarifying questions, tool confirmations, tool results, errors, no-results, booking details, suggestions, and every final response.`
            : selectedLanguage === 'HN'
                ? `RESPONSE LANGUAGE: Hindi (HN). Understand the user's Hindi, Kannada, English, mixed language, and Romanized speech naturally. ALWAYS reply in natural Hindi using Devanagari script. NEVER reply in Romanized Hindi or English unless the user explicitly asks for English. This applies to greetings, clarifying questions, tool confirmations, tool results, errors, no-results, booking details, suggestions, and every final response.`
                : `RESPONSE LANGUAGE: English (EN). ALWAYS reply in natural English.`;

        const conversationRules = `
IMPORTANT CONVERSATION RULES:
- You are the reasoning layer for GigSync. Use the available GigSync tools to understand and act on the user's request. Do NOT require the user to translate themselves into English.
- Distinguish these intents carefully: (a) a worker checking their own bookings for a date -> getWorkerBookings; (b) a worker asking about open/new work available -> getAvailableJobRequests; (c) a worker changing availability -> updateWorkerAvailability; (d) a customer creating a booking -> findWorkers/createJob flow.
- Example: "Did anyone book me tomorrow?" from a worker is a booking lookup, not an availability request.
- Example: "I want to book a painter tomorrow" from a customer is a customer booking request, not a worker availability request. Ask only for information that is genuinely missing.
- When information is ambiguous or incomplete, ask one concise clarification question in the selected language. Preserve all details already provided by the user and never ask them to repeat known details.
- Never claim that an action succeeded until the appropriate tool confirms success.
- If the request is a valid GigSync task, NEVER use the out-of-scope response merely because the wording is unfamiliar or multilingual.
- Customer/worker role boundary: if a customer asks for worker-only information (for example worker earnings, worker schedule, worker bookings, or worker availability), politely say that they need to log in as a worker, in the selected language. If a worker asks for customer-only actions, ask them to log in as a customer, in the selected language.
- Only use the out-of-scope fallback when the request is genuinely unrelated to GigSync. In KN: "ನಾನು GigSync ಏಜೆಂಟ್. GigSync ವೆಬ್‌ಸೈಟ್‌ಗೆ ಸಂಬಂಧಿಸಿದ ಕಾರ್ಯಗಳಲ್ಲಿ ಮಾತ್ರ ನಾನು ಸಹಾಯ ಮಾಡಬಹುದು." In HN: "मैं GigSync एजेंट हूँ। मैं केवल GigSync वेबसाइट से संबंधित कार्यों में आपकी सहायता कर सकता हूँ।" In EN: "I am the GigSync Agent. I can only assist with tasks related to the GigSync website."
- The user's selected language is a response/display preference, not a restriction on what language they may speak. Gemini must understand all three languages directly.
`;

        const systemInstruction = `You are GigSync AI, the dedicated AI voice & chat assistant for the GigSync platform — a hyperlocal marketplace for skilled workers in Tier-2 and Tier-3 Karnataka cities (Ramanagara, Kanakapura, Channapatna, Bengaluru, Mysuru, Bidadi, Magadi).

${languageInstruction}
${conversationRules}
STRICT PLATFORM GROUNDING & BOUNDARIES:
1. You MUST strictly base your responses on the GigSync website data, platform tools, and REAL DATABASE SNAPSHOT provided below.
2. DO NOT act as a general AI chatbot, trivia bot, coding assistant, or answer off-topic questions (e.g. general knowledge, entertainment, news, poetry, recipes).
3. Never invent or hallucinate worker names, prices, ratings, or bookings that are not present in tool results or database snapshots.

${identityBlock}

${isWorkerCall ? workerBrief : customerBrief}

STYLE: Short, clear, conversational sentences suitable for a voice call and chat interface. No markdown formatting, bulleted lists, or emojis in spoken responses.`;

        try {
            // Format history for Gemini API
            const contents = [];
            for (const h of session.history.slice(-8)) {
                contents.push({
                    role: h.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: h.text }]
                });
            }
            if (contents.length === 0 || contents[contents.length - 1].parts[0].text !== text) {
                contents.push({
                    role: 'user',
                    parts: [{ text }]
                });
            }

            const actionsPerformed = [];
            let toolExecuted = null;
            let toolResult = null;
            let shouldEndCall = false;

            // Gemini Function Calling Loop (up to 6 tool turns — a single question can need
            // several lookups, e.g. "who is my next customer and how much do they owe me")
            for (let step = 0; step < 6; step++) {
                const response = await this.generateWithFallback(client, {
                    contents,
                    config: {
                        systemInstruction,
                        tools: [{ functionDeclarations: GEMINI_TOOLS_DECLARATIONS }]
                    }
                });

                const candidate = response.candidates && response.candidates[0];
                if (!candidate || !candidate.content) break;

                const parts = candidate.content.parts || [];
                const functionCallPart = parts.find(p => p.functionCall);

                if (functionCallPart && functionCallPart.functionCall) {
                    const call = functionCallPart.functionCall;
                    toolExecuted = call.name;
                    const args = call.args || {};

                    // Default contextual arguments
                    if (!args.city) args.city = session.city;
                    if (!args.customerPhone) args.customerPhone = session.callerPhone;
                    if (!args.customerName) args.customerName = session.callerName;

                    // Identity is taken from the verified session, not from the transcript, so a
                    // mis-heard or spoken phone number can never read or edit someone else's record.
                    if (SELF_SCOPED_WORKER_TOOLS.has(call.name)) {
                        args.workerPhone = session.callerPhone;
                    } else if (!args.workerPhone) {
                        args.workerPhone = session.callerPhone;
                    }

                    // Execute tool from AI_TOOLS
                    if (typeof AI_TOOLS[call.name] === 'function') {
                        try {
                            toolResult = await AI_TOOLS[call.name](args);
                        } catch (toolErr) {
                            console.error(`[Gemini Engine] Tool '${call.name}' threw:`, toolErr.message);
                            toolResult = {
                                status: 'error',
                                persisted: false,
                                dataAvailable: false,
                                message: `The ${call.name} operation failed: ${toolErr.message}`
                            };
                        }
                        // Operator-facing audit line. The worker hears a plain spoken answer, so
                        // this is where a failed write or a failed cloud mirror has to become
                        // visible — otherwise nobody ever learns the sync is broken.
                        actionsPerformed.push(describeToolOutcome(call.name, toolResult));
                    } else {
                        toolResult = { status: 'error', message: `Unknown tool ${call.name}` };
                    }

                    // Append assistant function call and tool result to contents
                    contents.push(candidate.content);
                    contents.push({
                        role: 'user',
                        parts: [{
                            functionResponse: {
                                name: call.name,
                                response: { output: toolResult }
                            }
                        }]
                    });
                } else {
                    // Final text response generated
                    const spokenText = parts.map(p => p.text || '').join(' ').trim();

                    // Check for natural call closure
                    if (/goodbye|have a great day|have a good day|take care|bye|ಧನ್ಯವಾದ|ಶುಭ ದಿನ/i.test(spokenText) &&
                        /\b(thank you|bye|goodbye|thats all|that's all|nothing else|end call)\b/i.test(text.toLowerCase())) {
                        shouldEndCall = true;
                    }

                    return {
                        spokenResponse: spokenText,
                        toolExecuted,
                        toolResult,
                        actionsPerformed,
                        shouldEndCall,
                        modelUsed: this.lastModelUsed,
                        language: selectedLanguage
                    };
                }
            }
        } catch (err) {
            // Do NOT hide this. When the brain is down the caller deserves to know, instead of
            // getting a scripted line that looks like a real answer.
            this.lastError = err.message || String(err);
            console.error(`[Gemini Engine] Brain unavailable across models [${this.modelChain.join(', ')}]:`, this.lastError);
            return null;
        }

        return null;
    }
}

const geminiBrain = new GeminiConversationalBrain();

// 2. Multi-Turn Session & Memory Manager
class ConversationSessionManager {
    constructor() {
        this.sessions = new Map();
    }

    getSession(sessionId, defaultData = {}) {
        const key = sessionId || defaultData.callerPhone || 'default_session';
        let session = this.sessions.get(key);
        if (!session) {
            const saved = (DB && DB.getVoiceSession) ? DB.getVoiceSession(key) : null;
            if (saved) {
                session = saved;
                this.sessions.set(key, session);
            }
        }

        const rawPhone = defaultData.callerPhone ? String(defaultData.callerPhone).replace(/\D/g, '') : null;
        const cleanPhone = (rawPhone && rawPhone.length >= 10) ? rawPhone.slice(-10) : (rawPhone || null);
        const resolvedRole = defaultData.callerRole || (sessionId && sessionId.startsWith('work_') ? 'worker' : 'customer');

        if (!session) {
            session = {
                sessionId: key,
                callerPhone: cleanPhone,
                customerId: defaultData.customerId || null,
                workerId: defaultData.workerId || null,
                callerRole: resolvedRole,
                callerName: defaultData.callerName && defaultData.callerName !== 'User' ? defaultData.callerName : (resolvedRole === 'worker' ? 'Specialist' : 'Customer'),
                city: defaultData.city || 'Ramanagara',
                language: /^(KN|HN|EN)$/i.test(defaultData.language || '') ? String(defaultData.language).toUpperCase() : 'EN',
                history: [],
                workerDraft: {
                    name: null,
                    job_role: null,
                    phone: cleanPhone,
                    availability_date: null,
                    start_time: null,
                    end_time: null,
                    start_display: null,
                    end_display: null,
                    last_asked_field: null,
                    completed: false
                },
                customerDraft: {
                    service: null,
                    date: null,
                    time: null,
                    location: null,
                    pendingIntent: null
                },
                context: {
                    pendingIntent: null,
                    currentService: null,
                    currentLocation: defaultData.city || 'Ramanagara',
                    currentDate: null,
                    currentTime: null,
                    lastFoundWorkers: [],
                    lastSelectedWorker: null,
                    pendingJobData: null,
                    workerDraft: {
                        name: null,
                        phone: cleanPhone,
                        trade: null,
                        date: null,
                        startTime: null,
                        endTime: null,
                        startDisplay: null,
                        endDisplay: null,
                        hasAvailability: false
                    }
                },
                lastActivity: Date.now()
            };
            this.sessions.set(key, session);
        }

        session.lastActivity = Date.now();
        if (cleanPhone) {
            session.callerPhone = cleanPhone;
            if (!session.workerDraft.phone) session.workerDraft.phone = cleanPhone;
        }
        if (defaultData.customerId) session.customerId = defaultData.customerId;
        if (defaultData.workerId) session.workerId = defaultData.workerId;
        if (defaultData.city) session.city = defaultData.city;
        if (/^(KN|HN|EN)$/i.test(defaultData.language || '')) session.language = String(defaultData.language).toUpperCase();
        
        // If role switched on this session key, clean history & drafts so roles never conflict
        // Anonymous terminal requests are initially labelled customer by the
        // gateway. Once the caller selects worker/customer, preserve that
        // choice across subsequent HTTP turns instead of resetting the draft.
        const preserveTerminalRole = defaultData.portal === 'terminal' && session.terminalAccountChoice;
        if (defaultData.callerRole && defaultData.callerRole !== session.callerRole && !preserveTerminalRole) {
            session.callerRole = defaultData.callerRole;
            session.history = [];
            session.workerDraft = { name: null, job_role: null, phone: cleanPhone, availability_date: null, start_time: null, end_time: null, start_display: null, end_display: null, last_asked_field: null, completed: false };
            session.customerDraft = {};
        }

        if (defaultData.callerName && defaultData.callerName !== 'User' && defaultData.callerName !== 'Caller') {
            session.callerName = defaultData.callerName;
        }
        return session;
    }

    saveSession(session) {
        if (!session || !session.sessionId) return;
        this.sessions.set(session.sessionId, session);
        if (DB && DB.saveVoiceSession) {
            DB.saveVoiceSession(session.sessionId, session);
        }
    }

    resetSession(sessionId) {
        if (!sessionId) return;
        this.sessions.delete(sessionId);
        if (DB && DB.deleteVoiceSession) {
            DB.deleteVoiceSession(sessionId);
        }
    }

    addTurn(session, role, text) {
        session.history.push({ role, text, timestamp: new Date().toISOString() });
        // Keep last 16 turns to maintain sharp context
        if (session.history.length > 16) {
            session.history.shift();
        }
    }
}

const sessionManager = new ConversationSessionManager();

// 3. Location Entity Extractor
function extractLocationEntity(text, defaultCity = 'Ramanagara') {
    if (!text) return defaultCity;
    const lower = text.toLowerCase()
        .replace(/\ba\s*\.?\s*m\s*\.?(?=\s|$)/g, 'am')
        .replace(/\bp\s*\.?\s*m\s*\.?(?=\s|$)/g, 'pm');

    // Specific city / neighborhood matching FIRST
    const locationMap = [
        { patterns: ['ramanagara', 'ramnagar', 'ರಾಮನಗರ'], city: 'Ramanagara' },
        { patterns: ['kanakapura', 'kanakpur', 'ಕನಕಪುರ'], city: 'Kanakapura' },
        { patterns: ['channapatna', 'channapatana', 'ಚನ್ನಪಟ್ಟಣ'], city: 'Channapatna' },
        { patterns: ['bengaluru', 'bangalore', 'ಬೆಂಗಳೂರು'], city: 'Bengaluru' },
        { patterns: ['mysuru', 'mysore', 'ಮೈಸೂರು'], city: 'Mysuru' },
        { patterns: ['vijaya nagar', 'vijayanagar', 'ವಿಜಯನಗರ'], city: 'Vijaya Nagar' },
        { patterns: ['bidadi', 'ಬಿದದಿ'], city: 'Bidadi' },
        { patterns: ['magadi', 'ಮಾಗಡಿ'], city: 'Magadi' },
        { patterns: ['mandya', 'ಮಂಡ್ಯ'], city: 'Mandya' },
        { patterns: ['hassan', 'ಹಾಸನ'], city: 'Hassan' },
        { patterns: ['tumakuru', 'tumkur', 'ತುಮಕೂರು'], city: 'Tumakuru' },
        { patterns: ['shivamogga', 'shimoga', 'ಶಿವಮೊಗ್ಗ'], city: 'Shivamogga' },
        { patterns: ['davangere', 'ದಾವಣಗೆರೆ'], city: 'Davangere' },
        { patterns: ['belagavi', 'belgaum', 'ಬೆಳಗಾವಿ'], city: 'Belagavi' },
        { patterns: ['hubballi', 'hubli', 'ಹುಬ್ಬಳ್ಳಿ'], city: 'Hubballi' },
        { patterns: ['kannur'], city: 'Kannur' },
        { patterns: ['kasaragod'], city: 'Kasaragod' }
    ];

    for (const item of locationMap) {
        for (const pat of item.patterns) {
            const regex = new RegExp(`\\b${pat}\\b`, 'i');
            if (regex.test(lower)) {
                return item.city;
            }
        }
    }

    // Relative / local location references (with boundary checking to avoid false substring matches like 'is there')
    if (/\b(near me|my current location|my location|current location|around here|locally)\b/i.test(lower)) {
        return defaultCity;
    }

    // Fallback: Check preposition patterns (e.g. "in Mysore", "near Bidadi", "at Vijaya Nagar")
    const prepMatch = text.match(/\b(?:in|at|near|around|for)\s+([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)?)\b/);
    if (prepMatch && !/^(today|now|tomorrow|morning|afternoon|evening|tonight|monday|saturday|sunday)$/i.test(prepMatch[1])) {
        return prepMatch[1].trim();
    }

    return defaultCity;
}

// 4. Entity & Trade Extractor
function extractTradeAndService(text) {
    if (!text) return null;
    const lower = text.toLowerCase();

    // Specific Multi-word trades first
    if (lower.includes('washing machine') || lower.includes('washer') || lower.includes('വാഷിംഗ് മെಷೀನ್')) {
        return 'Washing Machine Repair';
    }
    if (lower.includes('water purifier') || lower.includes('ro technician') || lower.includes('aquaguard') || lower.includes('kent ro') || lower.includes('water filter')) {
        return 'Water Purifier & RO Service';
    }
    if (lower.includes('tv technician') || lower.includes('television') || lower.includes('led tv') || lower.includes('smart tv') || lower.includes('screen repair') || lower.includes('ಟಿವಿ')) {
        return 'TV & Electronics Repair';
    }
    if (lower.includes('refrigerator') || lower.includes('fridge') || lower.includes('deep freezer') || lower.includes('फ्रिज') || lower.includes('रेफ्रिजरेटर') || lower.includes('ಫ್ರಿಜ್') || lower.includes('ಫ್ರಿಡ್ಜ್')) {
        return 'Refrigerator Repair';
    }
    if (lower.includes('ac technician') || lower.includes('air conditioner') || lower.includes('split ac') || lower.includes('ac repair') || lower.includes('cooler') || lower.includes('एसी') || lower.includes('एयर कंडीशनर') || lower.includes('ಎಸಿ') || lower.includes('ಏರ್ ಕಂಡಿಷನರ್')) {
        return 'AC & Appliances';
    }
    if (lower.includes('bike mechanic') || lower.includes('two wheeler') || lower.includes('two-wheeler') || lower.includes('scooter') || lower.includes('motorcycle') || lower.includes('puncture') || lower.includes('bike repair') || lower.includes('दोपहिया') || lower.includes('बाइक') || lower.includes('स्कूटर') || lower.includes('ಎರಡು ಚಕ್ರ') || lower.includes('ಬೈಕ್') || lower.includes('ಸ್ಕೂಟರ್')) {
        return 'Mechanic';
    }
    if (lower.includes('pipe leakage') || lower.includes('leakage repair') || lower.includes('pipe repair') || lower.includes('leaking tap') || lower.includes('tap leak')) {
        return 'Plumbing';
    }

    // Single-word / Core Trade matchers (including common speech-to-text mishears & phonetic variants)
    if (lower.includes('electric') || lower.includes('cliteration') || lower.includes('literation') || lower.includes('elctric') || lower.includes('lectrition') || lower.includes('electritian') || lower.includes('electrition') || lower.includes('electrishan') || lower.includes('fan') || lower.includes('switch') || lower.includes('wire') || lower.includes('current') || lower.includes('power') || lower.includes('bulb') || lower.includes('ಎಲೆಕ್ಟ್ರಿಷಿಯನ್') || lower.includes('इलेक्ट्रिशियन') || lower.includes('इलेक्ट्रीशियन') || lower.includes('बिजली')) {
        return 'Electrical';
    }
    if (lower.includes('plumb') || lower.includes('plamber') || lower.includes('plamer') || lower.includes('pipe') || lower.includes('tap') || lower.includes('leak') || lower.includes('drain') || lower.includes('water') || lower.includes('प्लंबर') || lower.includes('नलसाज') || lower.includes('पाइप') || lower.includes('पानी') || lower.includes('ಪ್ಲಂಬರ್') || lower.includes('ಪ್ಲಂಬರ') || lower.includes('ಪ್ಲಂಬಾರ್') || lower.includes('ನೀರು')) {
        return 'Plumbing';
    }
    if (lower.includes('carpenter') || lower.includes('carpanter') || lower.includes('carpnter') || lower.includes('wood') || lower.includes('door') || lower.includes('window') || lower.includes('furniture') || lower.includes('lock') || lower.includes('बढ़ई') || lower.includes('कारपेंटर') || lower.includes('लकड़ी') || lower.includes('ಕಾರ್ಪೆಂಟರ್') || lower.includes('ಮರಗೆಲಸ')) {
        return 'Carpentry';
    }
    if (lower.includes('mason') || lower.includes('masonry') || lower.includes('brick') || lower.includes('plaster') || lower.includes('cement') || lower.includes('tile') || lower.includes('ಮೇಸ್ತ್ರಿ') || lower.includes('ಕಟ್ಟಡ')) {
        return 'Masonry & Construction';
    }
    if (lower.includes('tailor') || lower.includes('tailoring') || lower.includes('stitch') || lower.includes('alteration') || lower.includes('blouse') || lower.includes('dressmaker') || lower.includes('दर्जी') || lower.includes('सिलाई') || lower.includes('टेलर') || lower.includes('ಟೈಲರ್')) {
        return 'Tailoring & Alterations';
    }
    if (lower.includes('welder') || lower.includes('welding') || lower.includes('grill') || lower.includes('fabrication') || lower.includes('metal') || lower.includes('iron gate') || lower.includes('ವೆಲ್ಡರ್')) {
        return 'Welding & Metalwork';
    }
    if (lower.includes('driver') || lower.includes('driving') || lower.includes('chauffeur') || lower.includes('cab driver') || lower.includes('car driver') || lower.includes('ಡ್ರೈವರ್')) {
        return 'Driver Services';
    }
    if (lower.includes('mechanic') || lower.includes('mecanic') || lower.includes('makanic') || lower.includes('breakdown') || lower.includes('engine') || lower.includes('मैकेनिक') || lower.includes('मिस्त्री') || lower.includes('इंजन') || lower.includes('ಮೇಕಾನಿಕ್') || lower.includes('ಮೆಕ್ಯಾನಿಕ್')) {
        return 'Mechanic';
    }
    if (lower.includes('clean') || lower.includes('maid') || lower.includes('sweep') || lower.includes('wash') || lower.includes('deep clean') || lower.includes('सफाई') || lower.includes('सफाईकर्मी') || lower.includes('कामवाली') || lower.includes('ಕ್ಲೀನಿಂಗ್') || lower.includes('ಕ್ಲೀನರ್')) {
        return 'Home Cleaning';
    }
    if (lower.includes('paint') || lower.includes('painter') || lower.includes('पेंटर') || lower.includes('पेंट') || lower.includes('चित्रकार') || lower.includes('रंगाई') || lower.includes('रंगवाला') || lower.includes('whitewash') || lower.includes('wall paint') || lower.includes('ಬಣ್ಣ') || lower.includes('ಪೇಂಟರ್')) {
        return 'Painting';
    }

    return null;
}

// 5. Extract Date & Time Entities
function extractDateTimeEntities(text) {
    if (!text) return { date: 'Today', time: 'Immediate' };
    const lower = text.toLowerCase();
    let date = null;
    let time = null;

    const monthLookup = {
        january: 'January', jan: 'January',
        february: 'February', feb: 'February',
        march: 'March', mar: 'March',
        april: 'April', apr: 'April',
        may: 'May',
        june: 'June', jun: 'June',
        july: 'July', jul: 'July',
        august: 'August', aug: 'August',
        september: 'September', sept: 'September', sep: 'September',
        october: 'October', oct: 'October',
        november: 'November', nov: 'November',
        december: 'December', dec: 'December'
    };
    const ordinalSuffix = n => {
        const mod100 = n % 100;
        if (mod100 >= 11 && mod100 <= 13) return 'th';
        switch (n % 10) {
            case 1: return 'st';
            case 2: return 'nd';
            case 3: return 'rd';
            default: return 'th';
        }
    };
    const formatNaturalDateLabel = (day, month, year = null) => {
        const suffix = ordinalSuffix(day);
        return year ? `${day}${suffix} ${month} ${year}` : `${day}${suffix} ${month}`;
    };
    const spokenDayLookup = {
        first: 1, one: 1, ಫಸ್ಟ್: 1, ಒನ್: 1, ಒಂದು: 1, ಒಂದನೇ: 1,
        second: 2, two: 2, ಸೆಕೆಂಡ್: 2, ಟು: 2, ಎರಡು: 2, ಎರಡನೇ: 2,
        third: 3, three: 3, ಥರ್ಡ್: 3, ತ್ರೀ: 3, ಮೂರು: 3, ಮೂರನೇ: 3,
        fourth: 4, four: 4, ಫೋರ್: 4, ನಾಲ್ಕು: 4, ನಾಲ್ಕನೇ: 4,
        fifth: 5, five: 5, ಫಿಫ್ತ್: 5, ಫೈವ್: 5, ಐದು: 5, ಐದನೇ: 5,
        sixth: 6, six: 6, ಸಿಕ್ಸ್: 6, ಆರು: 6, ಆರನೇ: 6,
        seventh: 7, seven: 7, ಸೆವೆನ್: 7, ಏಳು: 7, ಏಳನೇ: 7,
        eighth: 8, eight: 8, ಎಯ್ಟ್: 8, ಏಟ್: 8, ಎಂಟು: 8, ಎಂಟನೇ: 8,
        ninth: 9, nine: 9, ನೈನ್: 9, ನಯನ್: 9, ಒಂಬತ್ತು: 9, ಒಂಬತ್ತನೇ: 9,
        tenth: 10, ten: 10, ಟೆನ್: 10, ಹತ್ತು: 10, ಹತ್ತನೇ: 10,
        eleventh: 11, eleven: 11, ಇಲೆವೆನ್: 11, ಹನ್ನೊಂದು: 11, ಹನ್ನೊಂದನೇ: 11,
        twelfth: 12, twelve: 12, ಟ್ವೆಲ್ವ್: 12, ಹನ್ನೆರಡು: 12, ಹನ್ನೆರಡನೇ: 12
    };

    const explicitDate = (() => {
        const normalized = lower.replace(/\bof\b/g, ' ').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
        const dayFirst = normalized.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:\s+(\d{4}))?\b/i);
        if (dayFirst) {
            const day = Number(dayFirst[1]);
            const month = monthLookup[dayFirst[2].toLowerCase()];
            if (month) return formatNaturalDateLabel(day, month, dayFirst[3] || null);
        }
        const monthFirst = normalized.match(/\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?\b/i);
        if (monthFirst) {
            const month = monthLookup[monthFirst[1].toLowerCase()];
            const day = Number(monthFirst[2]);
            if (month) return formatNaturalDateLabel(day, month, monthFirst[3] || null);
        }
        return null;
    })();

    if (explicitDate) {
        date = explicitDate;
    }

    // Web Speech returns Hindi calendar dates in Devanagari (for example,
    // "5 सितंबर"). Convert them to the same English label used by the
    // existing date normalizer so a new explicit date replaces an older
    // Tomorrow value in the conversation draft.
    if (!date) {
        const hindiMonths = {
            'जनवरी': 'January', 'फरवरी': 'February', 'मार्च': 'March',
            'अप्रैल': 'April', 'मई': 'May', 'जून': 'June', 'जुलाई': 'July',
            'अगस्त': 'August', 'सितंबर': 'September', 'सितम्बर': 'September',
            'अक्टूबर': 'October', 'नवंबर': 'November', 'नवम्बर': 'November',
            'दिसंबर': 'December', 'दिसम्बर': 'December'
        };
        const hindiDate = lower.match(/(\d{1,2})\s*(जनवरी|फरवरी|मार्च|अप्रैल|मई|जून|जुलाई|अगस्त|सितंबर|सितम्बर|अक्टूबर|नवंबर|नवम्बर|दिसंबर|दिसम्बर)(?:\s*(?:को|की तारीख))?/u);
        if (hindiDate) {
            const day = Number(hindiDate[1]);
            const month = hindiMonths[hindiDate[2]];
            if (day >= 1 && day <= 31 && month) date = formatNaturalDateLabel(day, month);
        }
    }

    if (!date) {
        const kannadaMonths = {
            'ಜನವರಿ': 'January', 'ಫೆಬ್ರವರಿ': 'February', 'ಮಾರ್ಚ್': 'March',
            'ಏಪ್ರಿಲ್': 'April', 'ಮೇ': 'May', 'ಜೂನ್': 'June', 'ಜುಲೈ': 'July',
            'ಆಗಸ್ಟ್': 'August', 'ಸೆಪ್ಟೆಂಬರ್': 'September', 'ಸೆಪ್ಟೆಂಬರ': 'September',
            'ಅಕ್ಟೋಬರ್': 'October', 'ನವೆಂಬರ್': 'November', 'ಡಿಸೆಂಬರ್': 'December'
        };
        const kannadaDate = lower.match(/(\d{1,2})\s*(ಜನವರಿ|ಫೆಬ್ರವರಿ|ಮಾರ್ಚ್|ಏಪ್ರಿಲ್|ಮೇ|ಜೂನ್|ಜುಲೈ|ಆಗಸ್ಟ್|ಸೆಪ್ಟೆಂಬರ್|ಸೆಪ್ಟೆಂಬರ|ಅಕ್ಟೋಬರ್|ನವೆಂಬರ್|ಡಿಸೆಂಬರ್)(?:\s*(?:ಕ್ಕೆ|ಗೆ|ರಂದು))?/u);
        if (kannadaDate) {
            const day = Number(kannadaDate[1]);
            const month = kannadaMonths[kannadaDate[2]];
            if (day >= 1 && day <= 31 && month) date = formatNaturalDateLabel(day, month);
        }
        if (!date) {
            const spokenKannadaDate = lower.match(/([a-z]+|[\u0C80-\u0CFF]+)\s*(ಜನವರಿ|ಫೆಬ್ರವರಿ|ಮಾರ್ಚ್|ಏಪ್ರಿಲ್|ಮೇ|ಜೂನ್|ಜುಲೈ|ಆಗಸ್ಟ್|ಸೆಪ್ಟೆಂಬರ್|ಸೆಪ್ಟೆಂಬರ|ಅಕ್ಟೋಬರ್|ನವೆಂಬರ್|ಡಿಸೆಂಬರ್)(?:\s*(?:ಕ್ಕೆ|ಗೆ|ರಂದು))?/u);
            if (spokenKannadaDate) {
                const day = spokenDayLookup[spokenKannadaDate[1]];
                const month = kannadaMonths[spokenKannadaDate[2]];
                if (day >= 1 && day <= 31 && month) date = formatNaturalDateLabel(day, month);
            }
        }
    }

    // Date Matching with Speech-to-Text Tolerance (tom, tmrw, today today, etc.)
    if (!date && lower.includes('tomorrow morning')) {
        date = 'Tomorrow';
        time = 'Morning (10:00 AM)';
    } else if (!date && lower.includes('tomorrow afternoon')) {
        date = 'Tomorrow';
        time = 'Afternoon (02:00 PM)';
    } else if (!date && lower.includes('tomorrow evening')) {
        date = 'Tomorrow';
        time = 'Evening (05:00 PM)';
    } else if (!date && lower.includes('this morning')) {
        date = 'Today';
        time = 'Morning (10:00 AM)';
    } else if (!date && lower.includes('this afternoon')) {
        date = 'Today';
        time = 'Afternoon (02:00 PM)';
    } else if (!date && lower.includes('this evening')) {
        date = 'Today';
        time = 'Evening (05:00 PM)';
    } else if (!date && (lower.includes('tonight') || lower.includes('this night'))) {
        date = 'Today';
        time = 'Night (08:00 PM)';
    } else if (!date && (lower.includes('next monday') || lower.includes('next week monday'))) {
        date = 'Next Monday';
    } else if (!date && (lower.includes('saturday') || lower.includes('shanivara'))) {
        date = 'Saturday';
    } else if (!date && (lower.includes('sunday') || lower.includes('bhanuvara'))) {
        date = 'Sunday';
    } else if (!date && (lower.includes('monday') || lower.includes('somavara'))) {
        date = 'Monday';
    } else if (!date && /\b(tom|tmrw|tomorrow|tomorrow\s+tomorrow|naale|ನಾಳೆ|kal)\b/i.test(lower)) {
        date = 'Tomorrow';
    } else if (!date && /\b(today|today\s+today|now|immediately|urgent|ivathu|ಇವತ್ತು|aaj)\b/i.test(lower)) {
        date = 'Today';
        if (lower.includes('now') || lower.includes('immediately') || lower.includes('urgent')) {
            time = 'Immediate';
        }
    }

    // Time Window / Range Matching
    if (lower.includes('from 9 am to 4 pm') || lower.includes('9 am to 4 pm') || lower.includes('9 to 4')) {
        time = '09:00 AM – 04:00 PM';
    } else if (lower.includes('after 5 pm') || lower.includes('post 5 pm') || lower.includes('evening after 5')) {
        time = 'After 05:00 PM';
    } else if (!time) {
        if (lower.includes('morning') || lower.includes('beligge') || lower.includes('ಬೆಳಿಗ್ಗೆ') || lower.includes('subah')) {
            time = 'Morning (10:00 AM)';
        } else if (lower.includes('afternoon') || lower.includes('madhyahna') || lower.includes('dopahar')) {
            time = 'Afternoon (02:00 PM)';
        } else if (lower.includes('evening') || lower.includes('sanje') || lower.includes('shaam')) {
            time = 'Evening (05:00 PM)';
        } else {
            const timeMatch = text.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm|o'clock)?)/i);
            if (timeMatch && !text.match(/₹|\brupees\b/i)) {
                time = timeMatch[1];
            }
        }
    }

    return {
        date: date || null,
        time: time || null
    };
}

// Helper to extract availability date (Today, Tomorrow, weekdays, ISO dates)
function extractAvailabilityDate(text) {
    if (!text) return null;
    const dt = extractDateTimeEntities(text);
    if (dt && dt.date) return dt.date;

    const lower = text.toLowerCase();
    const explicitDate = (() => {
        const normalized = lower.replace(/\bof\b/g, ' ').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
        const monthLookup = {
            january: 'January', jan: 'January',
            february: 'February', feb: 'February',
            march: 'March', mar: 'March',
            april: 'April', apr: 'April',
            may: 'May',
            june: 'June', jun: 'June',
            july: 'July', jul: 'July',
            august: 'August', aug: 'August',
            september: 'September', sept: 'September', sep: 'September',
            october: 'October', oct: 'October',
            november: 'November', nov: 'November',
            december: 'December', dec: 'December'
        };
        const ordinalSuffix = n => {
            const mod100 = n % 100;
            if (mod100 >= 11 && mod100 <= 13) return 'th';
            switch (n % 10) {
                case 1: return 'st';
                case 2: return 'nd';
                case 3: return 'rd';
                default: return 'th';
            }
        };
        const formatLabel = (day, month, year = null) => year ? `${day}${ordinalSuffix(day)} ${month} ${year}` : `${day}${ordinalSuffix(day)} ${month}`;
        const dayFirst = normalized.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:\s+(\d{4}))?\b/i);
        if (dayFirst) {
            const month = monthLookup[dayFirst[2].toLowerCase()];
            if (month) return formatLabel(Number(dayFirst[1]), month, dayFirst[3] || null);
        }
        const monthFirst = normalized.match(/\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?\b/i);
        if (monthFirst) {
            const month = monthLookup[monthFirst[1].toLowerCase()];
            if (month) return formatLabel(Number(monthFirst[2]), month, monthFirst[3] || null);
        }
        return null;
    })();
    if (explicitDate) return explicitDate;

    if (text.includes('कल') || text.includes('ನಾಳೆ')) return 'Tomorrow';
    if (text.includes('आज') || text.includes('ಇಂದು')) return 'Today';
    const dateMatch = lower.match(/\b(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tom|tmrw|naale|ivathu)\b/i);
    if (dateMatch) {
        const dStr = dateMatch[1].toLowerCase();
        if (dStr === 'tom' || dStr === 'tmrw' || dStr === 'naale') return 'Tomorrow';
        if (dStr === 'ivathu') return 'Today';
        return dStr.charAt(0).toUpperCase() + dStr.slice(1);
    }
    const isoMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (isoMatch) return isoMatch[1];
    return null;
}

function extractWeekdays(text) {
    if (!text) return [];
    const lower = text.toLowerCase();

    if (/\b(?:every\s+day|daily|each\s+day|all\s+days)\b/i.test(lower)) return [0, 1, 2, 3, 4, 5, 6];
    if (/\b(?:weekend|weekends)\b/i.test(lower)) return [0, 6];
    if (/\b(?:weekday|weekdays)\b/i.test(lower)) return [1, 2, 3, 4, 5];

    const map = [
        [/\b(?:sunday|sun)\b/i, 0],
        [/\b(?:monday|mon)\b/i, 1],
        [/\b(?:tuesday|tue|tues)\b/i, 2],
        [/\b(?:wednesday|wed)\b/i, 3],
        [/\b(?:thursday|thu|thur|thurs)\b/i, 4],
        [/\b(?:friday|fri)\b/i, 5],
        [/\b(?:saturday|sat)\b/i, 6]
    ];

    const out = [];
    for (const [regex, day] of map) {
        if (regex.test(lower) && !out.includes(day)) out.push(day);
    }
    return out;
}

function formatAvailabilityPatternLabel(pattern, date, daysOfWeek = []) {
    const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    if (pattern === 'daily') return 'every day';
    if (pattern === 'weekly' && Array.isArray(daysOfWeek) && daysOfWeek.length) {
        return `every ${daysOfWeek.map(d => weekdayNames[d]).filter(Boolean).join(', ')}`;
    }
    return date || 'Today';
}

// Helper to extract caller's name from natural utterances
function extractCallerName(text) {
    if (!text) return null;
    const clean = text.trim();
    const lower = clean.toLowerCase();

    // 1. Explicit pattern: "My name is Sourav", "I am Rajesh", "This is Gopal", "Call me Asad"
    const explicitMatch = clean.match(/\b(?:my name is|name is|this is|call me|i am|i'm|myself)\s+([A-Za-z]{2,20})\b/i);
    if (explicitMatch) {
        const candidate = explicitMatch[1].trim();
        const nonNames = ['an', 'a', 'the', 'electrician', 'plumber', 'carpenter', 'mechanic', 'painter', 'mason', 'tailor', 'welder', 'driver', 'specialist', 'technician', 'available', 'free', 'ready', 'calling', 'here', 'worker', 'registered', 'looking'];
        if (!nonNames.includes(candidate.toLowerCase())) {
            return candidate.charAt(0).toUpperCase() + candidate.slice(1).toLowerCase();
        }
    }

    // Hindi and Kannada Web Speech transcripts use native Unicode names.
    const nativeMatch = clean.match(/(?:मेरा\s+नाम|नाम\s+है|मेरा\s+नाम\s+है)\s*([\u0900-\u097F]{2,30})/u)
        || clean.match(/(?:ನನ್ನ\s+ಹೆಸರು|ಹೆಸರು)\s*([\u0C80-\u0CFF]{2,30})/u);
    if (nativeMatch) return nativeMatch[1].trim();

    // 2. Single or two-word standalone name: "Sourav", "Rajesh Kumar"
    const words = clean.split(/\s+/);
    if (words.length <= 2 && /^[A-Za-z\s]+$/.test(clean)) {
        const nonNames = [
            'hello', 'hi', 'hey', 'yes', 'no', 'ok', 'okay', 'sure', 'fine', 'thanks', 'thank you',
            'electrician', 'plumber', 'carpenter', 'mechanic', 'painter', 'mason', 'tailor', 'welder', 'driver',
            'specialist', 'technician', 'today', 'tomorrow', 'morning', 'evening', 'afternoon',
            'booking', 'bookings', 'job', 'jobs', 'work', 'worker', 'available', 'unavailable'
        ];
        if (!nonNames.includes(lower)) {
            return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
        }
    }

    // A standalone native-script name is a valid answer to the name prompt.
    if (words.length <= 2 && /^[\u0900-\u097F\u0C80-\u0CFF\s]+$/u.test(clean)
        && !/(हेलो|नमस्ते|हाँ|नहीं|ನಮಸ್ಕಾರ|ಹೌದು|ಇಲ್ಲ)/u.test(clean)) return clean;

    return null;
}

// Helper to convert trade category to natural specialist noun (e.g. Electrical -> an electrician)
function getTradePersonNoun(tradeCategory) {
    if (!tradeCategory) return 'a specialist';
    const t = tradeCategory.toLowerCase();
    if (t.includes('electr')) return 'an electrician';
    if (t.includes('plumb')) return 'a plumber';
    if (t.includes('carpent')) return 'a carpenter';
    if (t.includes('mechanic')) return 'a mechanic';
    if (t.includes('paint')) return 'a painter';
    if (t.includes('mason')) return 'a mason';
    if (t.includes('tailor')) return 'a tailor';
    if (t.includes('weld')) return 'a welder';
    if (t.includes('driver')) return 'a driver';
    if (t.includes('clean')) return 'a cleaning specialist';
    if (t.includes('tv') || t.includes('electronic')) return 'a TV repair specialist';
    if (t.includes('purifier') || t.includes('ro')) return 'a water purifier technician';
    if (t.includes('washing')) return 'a washing machine technician';
    if (t.includes('refrigerat') || t.includes('fridge')) return 'a refrigerator technician';
    if (t.includes('ac ') || t.includes('appliance')) return 'an appliance technician';
    return `a ${tradeCategory}`;
}

function assistantGreeting(language) {
    if (language === 'KN') return 'ಹಾಯ್, ನಾನು GigSync ನಿಮ್ಮ ಸಹಾಯಕ. ನಾನು ಹೇಗೆ ಸಹಾಯ ಮಾಡಲಿ?';
    if (language === 'HN') return 'हाय, मैं GigSync आपका सहायक हूँ। मैं आपकी कैसे मदद कर सकता हूँ?';
    return "Hi, I'm GigSync, your assistant. How may I help you?";
}

// Deterministic fallback responses must honor the selected script when the
// Gemini request is unavailable or returns the wrong language.
function localizeCustomerFallback(message, language) {
    if (!message || language === 'EN') return message;
    if (/I'm here to help you find and book verified specialists/i.test(message)) {
        return language === 'KN'
            ? 'ನಿಮಗೆ ಬೇಕಾದ ಸೇವೆಯನ್ನು ಹುಡುಕಿ ಬುಕ್ ಮಾಡಲು ನಾನು ಸಹಾಯ ಮಾಡುತ್ತೇನೆ. ಯಾವ ಸೇವೆ ಬೇಕು?'
            : 'मैं आपके लिए सत्यापित विशेषज्ञ ढूँढकर बुक करने में मदद करूँगा। आपको कौन सी सेवा चाहिए?';
    }
    if (/What service do you need today/i.test(message)) {
        return language === 'KN'
            ? 'ನಿಮಗೆ ಯಾವ ಸೇವೆ ಬೇಕು? ಉದಾಹರಣೆಗೆ ಪ್ಲಂಬರ್, ಎಲೆಕ್ಟ್ರಿಷಿಯನ್ ಅಥವಾ ಕ್ಲೀನರ್ ಎಂದು ಹೇಳಿ.'
            : 'आज आपको कौन सी सेवा चाहिए? जैसे प्लंबर, इलेक्ट्रिशियन या सफाई सेवा बताइए।';
    }
    const confirm = message.match(/Just to confirm: you want (.+?) on (.+?) at (.+?), estimated cost (₹\d+).*$/i);
    if (confirm) {
        const [, service, date, time, price] = confirm;
        return language === 'KN'
            ? `ದೃಢೀಕರಿಸಿ: ನಿಮಗೆ ${service} ಸೇವೆ ${date} ರಂದು ${time}ಕ್ಕೆ ಬೇಕು. ಅಂದಾಜು ವೆಚ್ಚ ${price}. ಬುಕ್ ಮಾಡಬೇಕೇ?`
            : `पुष्टि करें: आपको ${service} सेवा ${date} को ${time} बजे चाहिए। अनुमानित कीमत ${price} है। बुक करूँ?`;
    }
    if (/No verified specialists found/i.test(message)) {
        return language === 'KN' ? 'ಈಗ ಯಾವುದೇ ಪರಿಶೀಲಿತ ತಜ್ಞರು ಲಭ್ಯವಿಲ್ಲ. ನಿಮಗೆ ಯಾವ ಸೇವೆ ಬೇಕು?' : 'अभी कोई सत्यापित विशेषज्ञ उपलब्ध नहीं है। आपको कौन सी सेवा चाहिए?';
    }
    if (/^We have verified specialists in /i.test(message)) {
        let body = message.replace(/^We have verified specialists in /i, '').replace(/Would you like me to book one for you\?$/i, '').trim();
        if (language === 'KN') body = body.replace(/^Ramanagara:\s*/i, 'ರಾಮನಗರದಲ್ಲಿ ').replace(/Master Electrician|Electrician/gi, 'ಎಲೆಕ್ಟ್ರಿಷಿಯನ್').replace(/Plumber/gi, 'ಪ್ಲಂಬರ್').replace(/Carpenter/gi, 'ಕಾರ್ಪೆಂಟರ್').replace(/Painter/gi, 'ಪೇಂಟರ್').replace(/Tailor/gi, 'ಟೈಲರ್');
        if (language === 'HN') body = body.replace(/^Ramanagara:\s*/i, 'रमनागरा में ').replace(/Master Electrician|Electrician/gi, 'इलेक्ट्रिशियन').replace(/Plumber/gi, 'प्लंबर').replace(/Carpenter/gi, 'बढ़ई').replace(/Painter/gi, 'पेंटर').replace(/Tailor/gi, 'दर्जी');
        return language === 'KN'
            ? `${body} ಪರಿಶೀಲಿತ ತಜ್ಞರಲ್ಲಿ ಯಾರನ್ನಾದರೂ ಬುಕ್ ಮಾಡಬೇಕೇ?`
            : `${body} सत्यापित विशेषज्ञों में से किसी को बुक करूँ?`;
    }
    if (/^No verified specialists are available/i.test(message)) {
        return language === 'KN'
            ? 'ಆ ಸಮಯಕ್ಕೆ ಯಾವುದೇ ಪರಿಶೀಲಿತ ತಜ್ಞರು ಲಭ್ಯವಿಲ್ಲ. ಬೇರೆ ಸಮಯ ಪ್ರಯತ್ನಿಸಬೇಕೇ?'
            : 'उस समय के लिए कोई सत्यापित विशेषज्ञ उपलब्ध नहीं है। क्या आप कोई और समय आज़माना चाहेंगे?';
    }
    if (/^Just to confirm: you want to book /i.test(message) || /^Just to confirm: you want /i.test(message)) {
        const body = message.replace(/^Just to confirm:\s*/i, '').replace(/Shall I go ahead and book this\?$/i, '').trim();
        return language === 'KN' ? `ದೃಢೀಕರಿಸಿ: ${body}. ಇದನ್ನು ಬುಕ್ ಮಾಡಬೇಕೇ?` : `पुष्टि करें: ${body}। इसे बुक करूँ?`;
    }
    if (/^Done! (?:Your booking|Your service request)/i.test(message)) {
        const booking = message.match(/^Done! Your booking #([A-Z0-9-]+) for (.+?) with (.+?) on (.+?) at (.+?) is confirmed/i);
        if (booking) {
            return language === 'KN'
                ? `ನಿಮ್ಮ ಬುಕಿಂಗ್ #${booking[1]} ದೃಢೀಕರಿಸಲಾಗಿದೆ: ${booking[2]} - ${booking[3]}, ${booking[4]} ${booking[5]}. ವಿವರಗಳು ನಿಮ್ಮ ಡ್ಯಾಶ್‌ಬೋರ್ಡ್‌ನಲ್ಲಿ ಕಾಣಿಸುತ್ತವೆ.`
                : `आपकी बुकिंग #${booking[1]} कन्फर्म हो गई है: ${booking[2]} - ${booking[3]}, ${booking[4]} ${booking[5]}। विवरण आपके डैशबोर्ड में दिखाई देंगे।`;
        }
        const request = message.match(/^Done! Your service request #([A-Z0-9-]+) for (.+?) on (.+?) at (.+?) has been dispatched/i);
        if (request) {
            return language === 'KN'
                ? `ನಿಮ್ಮ ಸೇವಾ ವಿನಂತಿ #${request[1]} ರಚಿಸಲಾಗಿದೆ: ${request[2]}, ${request[3]} ${request[4]}. ವಿವರಗಳು ನಿಮ್ಮ ಡ್ಯಾಶ್‌ಬೋರ್ಡ್‌ನಲ್ಲಿ ಕಾಣಿಸುತ್ತವೆ.`
                : `आपका सेवा अनुरोध #${request[1]} बन गया है: ${request[2]}, ${request[3]} ${request[4]}। विवरण आपके डैशबोर्ड में दिखाई देंगे।`;
        }
        return language === 'KN' ? 'ನಿಮ್ಮ ಬುಕಿಂಗ್ ಯಶಸ್ವಿಯಾಗಿ ರಚಿಸಲಾಗಿದೆ. ವಿವರಗಳು ನಿಮ್ಮ ಡ್ಯಾಶ್‌ಬೋರ್ಡ್‌ನಲ್ಲಿ ಕಾಣಿಸುತ್ತವೆ.' : 'आपकी बुकिंग सफलतापूर्वक बन गई है। विवरण आपके डैशबोर्ड में दिखाई देंगे।';
    }
    return message;
}

function localizeWorkerFallback(message, language) {
    if (!message || language === 'EN') return message;
    if (/You don't have any bookings yet/i.test(message)) {
        return language === 'KN' ? 'ನಿಮಗೆ ಇನ್ನೂ ಯಾವುದೇ ಬುಕ್ಕಿಂಗ್‌ಗಳಿಲ್ಲ.' : 'आपके पास अभी कोई बुकिंग नहीं है।';
    }
    const many = message.match(/^Yes\. You have (\d+) bookings\.(.*)$/i);
    if (many) {
        return language === 'KN' ? `ಹೌದು. ನಿಮಗೆ ${many[1]} ಬುಕ್ಕಿಂಗ್‌ಗಳಿವೆ. ನಿಮ್ಮ ಎಲ್ಲಾ ಬುಕ್ಕಿಂಗ್‌ಗಳು ನಿಮ್ಮ ಡ್ಯಾಶ್‌ಬೋರ್ಡ್‌ನಲ್ಲಿ ಕಾಣಿಸುತ್ತವೆ.` : `हाँ। आपके पास ${many[1]} बुकिंग हैं। आपकी सभी बुकिंग आपके डैशबोर्ड में दिखाई देंगी।`;
    }
    if (/^Yes\. You have a booking/i.test(message)) return language === 'KN' ? 'ಹೌದು. ನಿಮಗೆ ಒಂದು ಬುಕ್ಕಿಂಗ್ ಇದೆ. ವಿವರಗಳು ನಿಮ್ಮ ಡ್ಯಾಶ್‌ಬೋರ್ಡ್‌ನಲ್ಲಿ ಕಾಣಿಸುತ್ತವೆ.' : 'हाँ। आपकी एक बुकिंग है। विवरण आपके डैशबोर्ड में दिखाई देंगे।';
    return message;
}

// Read-back of the authenticated worker's actual stored profile. Keep this
// deterministic so a Gemini timeout or a language switch cannot invent or
// lose personal details.
function localizedWorkerProfile(worker, language) {
    if (!worker) {
        if (language === 'KN') return 'ಈ ಫೋನ್ ಸಂಖ್ಯೆಗೆ ಕೆಲಸಗಾರರ ಪ್ರೊಫೈಲ್ ಕಂಡುಬಂದಿಲ್ಲ. ಮೊದಲು ನಿಮ್ಮ ಖಾತೆಗೆ ಲಾಗಿನ್ ಮಾಡಿ.';
        if (language === 'HN') return 'इस फोन नंबर से कोई कामगार प्रोफ़ाइल नहीं मिली। कृपया पहले अपने खाते में लॉगिन करें।';
        return 'I could not find a worker profile for this phone number. Please log in to your account first.';
    }
    const name = worker.name || (language === 'KN' ? 'ಗೊತ್ತಿಲ್ಲ' : language === 'HN' ? 'उपलब्ध नहीं' : 'not set');
    const trade = worker.trade || (language === 'KN' ? 'ಗೊತ್ತಿಲ್ಲ' : language === 'HN' ? 'उपलब्ध नहीं' : 'not set');
    const phone = worker.phone || (language === 'KN' ? 'ಉಪलब್ಧವಿಲ್ಲ' : language === 'HN' ? 'उपलब्ध नहीं' : 'not available');
    const city = worker.city || (language === 'KN' ? 'ಗೊತ್ತಿಲ್ಲ' : language === 'HN' ? 'उपलब्ध नहीं' : 'not set');
    const area = worker.area || '';
    const price = worker.price != null ? `₹${worker.price}` : (language === 'KN' ? 'ನಿಗದಿಪಡಿಸಿಲ್ಲ' : language === 'HN' ? 'तय नहीं' : 'not set');
    if (language === 'KN') return `ನಿಮ್ಮ ಪ್ರೊಫೈಲ್ ವಿವರಗಳು: ಹೆಸರು ${name}, ಕೆಲಸ ${trade}, ಫೋನ್ ${phone}, ಸ್ಥಳ ${city}${area ? `, ${area}` : ''}, ಆರಂಭಿಕ ಬೆಲೆ ${price}.`;
    if (language === 'HN') return `आपकी प्रोफ़ाइल जानकारी: नाम ${name}, काम ${trade}, फोन ${phone}, स्थान ${city}${area ? `, ${area}` : ''}, शुरुआती कीमत ${price}।`;
    return `Your profile details are: name ${name}, trade ${trade}, phone ${phone}, location ${city}${area ? `, ${area}` : ''}, and starting price ${price}.`;
}

function getAvailableWorkersForSlot(workers = [], requestedDate = null, requestedTime = null, requestedEndTime = null) {
    if (!requestedDate || !requestedTime) return workers;
    return workers.filter(w => DB.checkScheduleConflict(w.id, requestedDate, requestedTime, requestedEndTime) === null);
}

function workerPrompt(session, key, english) {
    const lang = session.language || 'EN';
    const prompts = {
        KN: { name: 'ನಿಮ್ಮ ಹೆಸರು ಏನು?', trade: 'ನೀವು ಯಾವ ರೀತಿಯ ಕೆಲಸ ಮಾಡುತ್ತೀರಿ?', phone: 'ನಿಮ್ಮ 10 ಅಂಕಿಯ ಮೊಬೈಲ್ ಸಂಖ್ಯೆಯನ್ನು ಹೇಳಿ.', date: 'ನೀವು ಯಾವ ದಿನ ಲಭ್ಯವಿರುತ್ತೀರಿ?', time: 'ದಯವಿಟ್ಟು ಪ್ರಾರಂಭ ಮತ್ತು ಅಂತ್ಯದ ಸಮಯ ಎರಡನ್ನೂ ಹೇಳಿ.', end: 'ನೀವು ಯಾವ ಸಮಯದವರೆಗೆ ಲಭ್ಯವಿರುತ್ತೀರಿ?', password: 'ನಿಮ್ಮ ಖಾತೆಗೆ ಲಾಗಿನ್ ಮಾಡಲು ಕನಿಷ್ಠ 6 ಅಂಕಿಗಳ ಪಾಸ್‌ವರ್ಡ್ ರಚಿಸಿ.', confirm: 'ಈ ವಿವರಗಳನ್ನು ಉಳಿಸಬೇಕೇ?' },
        HN: { name: 'आपका नाम क्या है?', trade: 'आप किस तरह का काम करते हैं?', phone: 'अपना 10 अंकों का मोबाइल नंबर बताइए।', date: 'आप किस तारीख को उपलब्ध हैं?', time: 'कृपया शुरू और समाप्ति दोनों समय बताइए।', end: 'आप किस समय तक उपलब्ध रहेंगे?', password: 'अपने खाते में लॉगिन करने के लिए कम से कम 6 अक्षरों का पासवर्ड बनाइए।', confirm: 'क्या मैं इन विवरणों को सहेज दूँ?' }
    };
    return (prompts[lang] && prompts[lang][key]) || english;
}

// Helper to extract start and end time range from natural utterances
function extractTimeRange(text) {
    if (!text) return null;
    let lower = text.toLowerCase()
        // Common speech-to-text Kannada/phonetic number words.
        .replace(/ಮತ್ತೊಂದು|ಒಂದನೇ|ಒಂದು|ಒನ್|ಫಸ್ಟ್/gu, '1')
        .replace(/ಎರಡನೇ|ಎರಡು|ಟು|ಟೂ|ಸೆಕೆಂಡ್/gu, '2')
        .replace(/ಮೂರನೇ|ಮೂರು|ಥರ್ಡ್|ತ್ರೀ/gu, '3')
        .replace(/ನಾಲ್ಕನೇ|ನಾಲ್ಕು/gu, '4')
        .replace(/ಐದನೇ|ಐದು|ಫಿಫ್ತ್|ಫೈವ್/gu, '5')
        .replace(/ಆರನೇ|ಆರು|ಸಿಕ್ಸ್/gu, '6')
        .replace(/ಏಳನೇ|ಏಳು|ಸೆವೆನ್/gu, '7')
        .replace(/ಎಂಟನೇ|ಎಂಟು/gu, '8')
        .replace(/ಒಂಬತ್ತನೇ|ಒಂಬತ್ತು/gu, '9')
        .replace(/ಹತ್ತಿಂದ|ಟೆನ್ನಿಂದ/gu, '10 ರಿಂದ')
        .replace(/ಹತ್ತನೇ|ಹತ್ತು/gu, '10')
        .replace(/ಹನ್ನೊಂದನೇ|ಹನ್ನೊಂದು|ಇಲೆವೆನ್/gu, '11')
        .replace(/ಹನ್ನೆರಡನೇ|ಹನ್ನೆರಡು|ಟ್ವೆಲ್ವ್/gu, '12')
        .replace(/ನೈನ್|ನಯನ್|ನೈನ/gu, '9')
        .replace(/ಫೋರ್|ಫೋರು/gu, '4')
        .replace(/ಎಯ್ಟ್|ಏಟ್/gu, '8')
        .replace(/ಟೆನ್/gu, '10')
        // Common Hindi number words when recognition returns words.
        .replace(/नौ/gu, '9')
        .replace(/चार/gu, '4')
        .replace(/आठ/gu, '8')
        .replace(/दस/gu, '10')
        // Web Speech commonly returns dotted a.m./p.m.; normalise before parsing.
        .replace(/\ba\s*\.?\s*m\s*\.?(?=\s|$)/g, 'am')
        .replace(/\bp\s*\.?\s*m\s*\.?(?=\s|$)/g, 'pm')
        .replace(/\bo'clock\b/g, '')
        // Hindi and Kannada range connectors, including "9 से 4 बजे तक".
        .replace(/\s*(?:से|तक|ವರೆಗೆ)\s*/gu, ' to ')
        .replace(/\s*(?:ರಿಂದ|ಇಂದ|ಯಿಂದ)\s*/gu, ' to ')
        .replace(/\s*बजे\s*/gu, ' ');

    // 1. Natural keywords without numbers
    if (lower.includes('evening') && !lower.match(/\d/)) {
        return { startTime: '05:00 PM', endTime: '09:00 PM', startDisplay: '5 PM', endDisplay: '9 PM' };
    }
    if (lower.includes('morning') && !lower.match(/\d/)) {
        return { startTime: '09:00 AM', endTime: '01:00 PM', startDisplay: '9 AM', endDisplay: '1 PM' };
    }
    if (lower.includes('afternoon') && !lower.match(/\d/)) {
        return { startTime: '01:00 PM', endTime: '05:00 PM', startDisplay: '1 PM', endDisplay: '5 PM' };
    }

    // Prefer the unambiguous common form before the permissive multilingual
    // matcher below. The older expression could consume "8 AM to 4 PM" and
    // return 8 AM for both ends.
    const explicitRange = lower.match(/\b(\d{1,2}(?::\d{2})?)\s*(am|pm)\s*(?:to|till|until|inda|inda\s*te|-)\s*(\d{1,2}(?::\d{2})?)\s*(am|pm)\b/i);
    if (explicitRange) {
        const [, start, startMeridiem, end, endMeridiem] = explicitRange;
        const format = (value, meridiem) => {
            const [hourText, minuteText = '00'] = value.split(':');
            const hour = Number(hourText);
            const suffix = meridiem.toUpperCase();
            return { value: `${String(hour).padStart(2, '0')}:${minuteText} ${suffix}`, display: `${hour}${minuteText !== '00' ? `:${minuteText}` : ''} ${suffix}` };
        };
        const startValue = format(start, startMeridiem);
        const endValue = format(end, endMeridiem);
        return { startTime: startValue.value, endTime: endValue.value, startDisplay: startValue.display, endDisplay: endValue.display };
    }

    // 2. Explicit or implicit range match:
    // e.g. "9:00 to 10:00", "9 to 10", "9 am to 5 pm", "10 to 2", "2 pm to 6 pm", "5 to 5 to 10:00 am", "5 am to 10 am"
    const rangeMatch = lower.match(/(\d{1,2}(?::\d{2})?)\s*(am|pm|in the morning|in the evening|in the afternoon)?(?:\s*(?:to|till|until|inda|inda\s*te|\-)\s*\d{1,2}(?::\d{2})?)*\s*(?:to|till|until|inda|inda\s*te|\-)\s*(\d{1,2}(?::\d{2})?)\s*(am|pm|in the morning|in the evening|in the afternoon|varege)?/i);

    if (rangeMatch) {
        const sStr = rangeMatch[1];
        const sExp = rangeMatch[2] || '';
        const eStr = rangeMatch[3];
        const eExp = rangeMatch[4] || '';

        const sParts = sStr.split(':');
        const eParts = eStr.split(':');
        const sHour = parseInt(sParts[0], 10);
        const sMin = sParts[1] || '00';
        const eHour = parseInt(eParts[0], 10);
        const eMin = eParts[1] || '00';

        let sAmPm = null;
        let eAmPm = null;

        // Check explicit start AM/PM
        if (sExp.includes('am') || sExp.includes('morning') || lower.includes(sStr + ' am') || lower.includes(sStr + 'am')) sAmPm = 'AM';
        else if (sExp.includes('pm') || sExp.includes('evening') || sExp.includes('afternoon') || lower.includes(sStr + ' pm') || lower.includes(sStr + 'pm')) sAmPm = 'PM';

        // Check explicit end AM/PM
        if (eExp.includes('am') || eExp.includes('morning') || lower.includes(eStr + ' am') || lower.includes(eStr + 'am')) eAmPm = 'AM';
        else if (eExp.includes('pm') || eExp.includes('evening') || eExp.includes('afternoon') || lower.includes(eStr + ' pm') || lower.includes(eStr + 'pm')) eAmPm = 'PM';

        // Deduce AM/PM if not explicitly given
        if (!sAmPm && !eAmPm) {
            if (sHour >= 5 && sHour <= 11) {
                sAmPm = 'AM';
                if (eHour === 12) {
                    eAmPm = 'PM'; // noon
                } else if (eHour > sHour && eHour <= 11) {
                    // e.g. 5 to 10, 9 to 10, 8 to 11 -> both AM
                    eAmPm = 'AM';
                } else {
                    // e.g. 9 to 5, 10 to 2, 8 to 4 -> crosses noon to PM
                    eAmPm = 'PM';
                }
            } else if (sHour === 12) {
                sAmPm = 'PM';
                eAmPm = 'PM';
            } else if (sHour >= 1 && sHour <= 5) {
                sAmPm = 'PM';
                eAmPm = 'PM';
            } else {
                sAmPm = 'AM';
                eAmPm = (eHour > sHour && eHour <= 11) ? 'AM' : 'PM';
            }
        } else if (sAmPm && !eAmPm) {
            if (sAmPm === 'AM') {
                if (eHour > sHour && eHour <= 11) eAmPm = 'AM';
                else eAmPm = 'PM';
            } else {
                eAmPm = 'PM';
            }
        } else if (!sAmPm && eAmPm) {
            if (eAmPm === 'PM') {
                if (sHour >= 6 && sHour <= 11) sAmPm = 'AM';
                else sAmPm = 'PM';
            } else {
                sAmPm = 'AM';
            }
        }

        const sHourPad = sHour < 10 ? '0' + sHour : String(sHour);
        const eHourPad = eHour < 10 ? '0' + eHour : String(eHour);

        const startTime = `${sHourPad}:${sMin} ${sAmPm}`;
        const endTime = `${eHourPad}:${eMin} ${eAmPm}`;
        const startDisplay = `${sHour}${sMin !== '00' ? ':' + sMin : ''} ${sAmPm}`;
        const endDisplay = `${eHour}${eMin !== '00' ? ':' + eMin : ''} ${eAmPm}`;

        return { startTime, endTime, startDisplay, endDisplay };
    }

    return null;
}

// Helper to extract time window (either range or specific time)
function extractTimeWindow(text) {
    // Keep a lone "10 o'clock" as one point in time.  The range parser removes
    // that wording while normalising input, which otherwise made it look like
    // an invalid zero-length range.
    const clockOnly = String(text || '').toLowerCase().match(/\b(?:at\s+|by\s+|around\s+|for\s+)?(\d{1,2})(?:\s*o['’]?clock)\b/i);
    if (clockOnly) {
        const hour = Number(clockOnly[1]);
        return { startTime: `${String(hour).padStart(2, '0')}:00 AM`, endTime: `${String(hour).padStart(2, '0')}:00 AM`, startDisplay: `${hour} AM`, endDisplay: `${hour} AM` };
    }
    // Numeric Kannada/Hindi range spoken without English connectors.
    const nativeRange = String(text || '').match(/(\d{1,2}(?::\d{2})?)(?:\s*(?:ರಿಂದ|ಇಂದ|ಯಿಂದ|से|तक|वाजे तक|ವರೆಗೆ)\s*)(\d{1,2}(?::\d{2})?)(?:\s*(?:ಕ್ಕೆ|ಗೆ))?/u);
    if (nativeRange) {
        return extractTimeRange(`${nativeRange[1]} to ${nativeRange[2]}`);
    }
    const range = extractTimeRange(text);
    if (range) return range;

    if (!text) return null;
    const lower = text.toLowerCase()
        .replace(/\ba\s*\.?\s*m\s*\.?(?=\s|$)/g, 'am')
        .replace(/\bp\s*\.?\s*m\s*\.?(?=\s|$)/g, 'pm');
    const singleMatch = lower.match(/\b(?:at\s+|by\s+|around\s+|for\s+)?(\d{1,2}(?::\d{2})?)\s*(am|pm)\b/i);
    if (singleMatch) {
        const timeStr = singleMatch[1];
        const ampm = singleMatch[2].toUpperCase();
        const parts = timeStr.split(':');
        const hour = parseInt(parts[0], 10);
        const min = parts[1] || '00';
        const hourPad = hour < 10 ? '0' + hour : String(hour);
        const startTime = `${hourPad}:${min} ${ampm}`;
        const startDisplay = `${hour}${min !== '00' ? ':' + min : ''} ${ampm}`;
        return { startTime, endTime: startTime, startDisplay, endDisplay: startDisplay };
    }
    return null;
}

// Helper to extract 10-digit Indian phone number from utterance
function extractPhoneNumber(text) {
    if (!text) return null;
    
    // 1. Convert spoken digit words to numbers if present
    const wordToDigit = {
        zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
        six: '6', seven: '7', eight: '8', nine: '9'
    };
    const normalized = text.toLowerCase().replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine)\b/g, m => wordToDigit[m]);

    // 2. Extract digits only from the utterance
    const digitsOnly = normalized.replace(/\D/g, '');

    // 3. Match 10-digit mobile number with or without +91 / 91 / 0 prefix
    if (digitsOnly.length === 10 && /^[6-9]\d{9}$/.test(digitsOnly)) {
        return digitsOnly;
    }
    if (digitsOnly.length === 11 && digitsOnly.startsWith('0') && /^[6-9]\d{9}$/.test(digitsOnly.slice(1))) {
        return digitsOnly.slice(1);
    }
    if (digitsOnly.length === 12 && digitsOnly.startsWith('91') && /^[6-9]\d{9}$/.test(digitsOnly.slice(2))) {
        return digitsOnly.slice(2);
    }
    
    // Check embedded 10-digit sequence
    const embeddedMatch = digitsOnly.match(/([6-9]\d{9})/);
    if (embeddedMatch) {
        return embeddedMatch[1];
    }

    return null;
}

// Helper to identify whether caller is self-identifying as a worker or providing worker availability
function isWorkerIntent(text, currentRole = 'customer') {
    if (!text) return false;
    const lower = text.toLowerCase();

    // Inquiries asking about current availability or schedule are questions, not availability declarations
    if (/\b(?:am i available|am i free|check my availability|my working hours|what are my hours|what jobs|who is my next|where is my next|how much did i earn|what are my details|what is my profile)\b/i.test(lower)) {
        return false;
    }

    // Customer explicit inquiries or search requests (English / Kannada)
    if (/\b(?:which|who|find|search|need|looking for|look for|want to hire|can you|send me|book me|beku|ಬೇಕು|is there|are there|how many|show me specialists|show me workers)\b/i.test(lower)) {
        return false;
    }
    if (/\b(?:nanage|ನನಗೆ)\b/i.test(lower) && /\b(?:beku|ಬೇಕಾಗಿದೆ|ಬೇಕು)\b/i.test(lower)) {
        return false;
    }

    // Direct worker self-identification & availability statements in English / Kannada / Kanglish
    const selfIdPatterns = [
        /\b(?:i am|i'm|myself|i work as|naanu|ನಾನು|naan)\s+(?:an?|a registered|a skilled)?\s*(?:electrician|plumber|carpenter|mechanic|painter|technician|mason|tailor|welder|driver|specialist|cliteration|literation|electritian|electrition|electrishan|ಎಲೆಕ್ಟ್ರಿಷಿಯನ್|ಪ್ಲಂಬರ್|ಕಾರ್ಪೆಂಟರ್|ಮೆಕ್ಯಾನಿಕ್)\b/i,
        /\b(?:my name is|name is|this is|hesaru|ಹೆಸರು)\s+[a-z]+\s+(?:and\s+)?(?:i am|i'm|i work as|naanu)\s+(?:an?|a)?\s*(?:electrician|plumber|carpenter|mechanic|painter|technician|mason|tailor|welder|driver)\b/i,
        /\b(?:my name is|name is|this is)\s+[a-z]+\s+(?:and\s+)?(?:i'm\s+available|i am\s+available|available)\b/i,
        /\b(?:i am|i'm|myself|iddini|ಇದ್ದೇನೆ)\s+(?:available|free|on duty|off duty|labhyaviddini|ಲಭ್ಯ)\s+(?:from|for|today|tomorrow|naale|ivathu|now|between|till|after|\d)\b/i,
        /\b(?:wanted to work|want to work|ready to work|kelasa madalu|kelasa madbeku|i wanted to work|i want to work)\b/i,
        /\b(?:my availability|my schedule|my working hours|my shift|nanna availability|nanna schedule)\s+(?:is|for|from|to|inda)\b/i,
        /\b(?:set|update|change|mark|add)\s+(?:my\s+|tomorrow's\s+|today's\s+)?(?:availability|schedule|timing|shift|hours)\b/i,
        /\b(?:i can work|i will be available|i am not available|i won't be available|i will work|add me as available)\b/i,
        /\b(?:register me|add me|sign me up|join as worker|i am a new worker|new worker|register as worker|add me as|i want to register|i would like to add me|add me a|add me an)\b/i,
        /\b(?:my number is|my phone is|phone number is)\s*[\d\s]+\b/i,
        /\b(?:free today|free tomorrow|available today|available tomorrow)\b/i,
        /\b(?:not available on|make me unavailable|cancel my availability|cancel availability|not available)\b/i,
        /\b(?:inda|ರಿಂದ)\s+\d{1,2}\s*(?:to|till|varege|ವರೆಗೆ)\s+\d{1,2}\s*(?:available|iddini|ಇದ್ದೇನೆ)\b/i
    ];

    for (const pat of selfIdPatterns) {
        if (pat.test(lower)) return true;
    }

    return false;
}

// =============================================================================
// 4A. DEDICATED CUSTOMER CONVERSATIONAL ENGINE
// =============================================================================
async function processCustomerTurn(session, text, actionsPerformed) {
    const lower = text.toLowerCase().trim();
    const rawPhone = (session.callerPhone || '').replace(/\D/g, '');
    const customerPhone = rawPhone.length >= 10 ? rawPhone.slice(-10) : (rawPhone || null);
    const customerName = (session.callerName && session.callerName !== 'User' && session.callerName !== 'Caller' && session.callerName !== 'Specialist') ? session.callerName : 'Customer';
    const city = session.city || 'Ramanagara';

    if (!session.customerDraft || typeof session.customerDraft !== 'object') {
        session.customerDraft = {};
    }
    const draft = session.customerDraft;

    if (session.isVoiceCall && session.voiceSignupComplete && draft.accountCreated) {
        const loginPrompt = session.language === 'KN'
            ? 'ನಿಮ್ಮ ಖಾತೆ ಯಶಸ್ವಿಯಾಗಿ ರಚಿಸಲಾಗಿದೆ. ದಯವಿಟ್ಟು ಫೋನ್ ಸಂಖ್ಯೆ ಮತ್ತು ಪಾಸ್‌ವರ್ಡ್ ಬಳಸಿ ಲಾಗಿನ್ ಮಾಡಿ.'
            : session.language === 'HN'
                ? 'आपका खाता सफलतापूर्वक बन गया है। कृपया फोन नंबर और पासवर्ड से लॉगिन करें।'
                : 'Your account was created successfully. Please log in with your phone number and password.';
        return { spokenResponse: loginPrompt, detectedIntent: 'login_required_after_signup' };
    }

    // Anonymous Voice Terminal customer signup. The terminal chooses the
    // account type before entering either workflow, then stores the caller's
    // name, phone and password in the real users/customers tables.
    if (session.isVoiceCall && session.terminalAccountChoice === 'customer' && !draft.accountCreated) {
        if (!draft.signupField) draft.signupField = 'name';
        const fieldAtStart = draft.signupField;
        // If speech recognition delivers a name while the prompt state is
        // slightly behind (common when switching Kannada/Hindi mid-call),
        // capture it before processing the current field.
        if (!draft.name && /[\u0900-\u097F\u0C80-\u0CFF]/u.test(text)) {
            const nativeName = text.replace(/(?:मेरा\s+नाम(?:\s+है)?|ನನ್ನ\s+ಹೆಸರು)\s*/iu, '').replace(/[^\p{L}\s]/gu, '').trim();
            if (nativeName.length >= 2 && !/(हेलो|नमस्ते|ಗ್ರಾಹಕ|ग्राहक|कामगार|ಕೆಲಸಗಾರ)/u.test(nativeName)) {
                draft.name = nativeName;
                if (draft.signupField === 'name') draft.signupField = 'phone';
            }
        }
        if (fieldAtStart === 'name') {
            const m = text.match(/(?:my name is|name is|i am|i'm|this is|call me)\s+(.+)/i);
            const rawName = (m ? m[1] : text).trim();
            const name = /[\u0900-\u097F\u0C80-\u0CFF]/u.test(rawName)
                ? rawName.replace(/[^\p{L}\s]/gu, '').trim()
                : rawName.replace(/[^a-zA-Z\s]/g, '').trim();
            if (name.length >= 2 && !/^(hi|hello|yes|customer)$/i.test(name)) {
                draft.name = name.split(/\s+/).map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
                draft.signupField = 'phone';
            }
        } else if (fieldAtStart === 'phone') {
            const p = extractPhoneNumber(text);
            if (p) { draft.phone = p; draft.signupField = 'password'; }
        } else if (fieldAtStart === 'password') {
            const p = text.trim().replace(/^(my password is|password is|password|पासवर्ड है|पासवर्ड|ಪಾಸ್‌ವರ್ಡ್)\s*/iu, '').trim();
            if (p.length >= 6 && !/\s/.test(p)) { draft.password = p; draft.signupField = 'confirm'; }
        } else if (fieldAtStart === 'confirm') {
            if (/^(yes|yeah|yep|sure|correct|right|okay|ok|confirm|confirmed|ha|ಹೌದು|ಹೌದಾ|हाँ|हां|हांबना)(?:\b|\s|$)/iu.test(lower)) {
                const user = DB.registerUser({ name: draft.name, phone: draft.phone, password: draft.password, role: 'customer', city: session.city || 'Ramanagara' });
                if (user) {
                    draft.accountCreated = true;
                    session.voiceSignupComplete = true;
                    session.callerPhone = draft.phone;
                    session.callerName = draft.name;
                    session.callerRole = 'customer';
                    const doneMessage = session.language === 'KN'
                        ? `ಆಯಿತು, ${draft.name}. ನಿಮ್ಮ ಗ್ರಾಹಕರ ಖಾತೆ ಯಶಸ್ವಿಯಾಗಿ ರಚಿಸಲಾಗಿದೆ. ಫೋನ್ ಸಂಖ್ಯೆ ಮತ್ತು ಪಾಸ್‌ವರ್ಡ್ ಬಳಸಿ ಲಾಗಿನ್ ಮಾಡಿ.`
                        : session.language === 'HN'
                            ? `हो गया, ${draft.name}. आपका ग्राहक खाता सफलतापूर्वक बन गया है। फोन नंबर और पासवर्ड से लॉगिन करें।`
                            : `Done, ${draft.name}. Your customer account was created successfully. Please log in with your phone number and password.`;
                    return { spokenResponse: doneMessage, detectedIntent: 'customer_registered', toolExecuted: 'registerUser' };
                }
                return { spokenResponse: 'I could not save your customer account right now. Please try again.', detectedIntent: 'customer_registration_failed' };
            }
        }
        const prompts = {
            EN: { name: 'What is your name?', phone: 'What is your 10-digit phone number?', password: 'Please create a password with at least 6 characters.', confirm: `Just to confirm, your name is ${draft.name}, your phone number is ${draft.phone}. Shall I create your customer account?` },
            KN: { name: 'ನಿಮ್ಮ ಹೆಸರು ಏನು?', phone: 'ನಿಮ್ಮ 10 ಅಂಕಿಯ ಮೊಬೈಲ್ ಸಂಖ್ಯೆಯನ್ನು ಹೇಳಿ.', password: 'ಕನಿಷ್ಠ 6 ಅಕ್ಷರಗಳ ಪಾಸ್‌ವರ್ಡ್ ರಚಿಸಿ.', confirm: `ನಿಮ್ಮ ಹೆಸರು ${draft.name}, ಫೋನ್ ${draft.phone}. ಗ್ರಾಹಕರ ಖಾತೆಯನ್ನು ರಚಿಸಬೇಕೇ?` },
            HN: { name: 'आपका नाम क्या है?', phone: 'अपना 10 अंकों का मोबाइल नंबर बताइए।', password: 'कम से कम 6 अक्षरों का पासवर्ड बनाइए।', confirm: `आपका नाम ${draft.name} और फोन ${draft.phone} है। ग्राहक खाता बनाऊँ?` }
        }[session.language || 'EN'];
        return { spokenResponse: prompts[draft.signupField], detectedIntent: `ask_customer_${draft.signupField}` };
    }

    // 1. Gratitude & Goodbye
    if (/\b(thank you|thanks|thank you so much|dhanyavada|dhanyavadagalu|shukriya|bye|goodbye|that's all|thats all|see you)\b/i.test(lower) && lower.split(/\s+/).length <= 6) {
        actionsPerformed.push('Customer ended conversation');
        return {
            spokenResponse: "You're welcome! Feel free to reach out anytime you need a specialist. Have a great day!",
            shouldEndCall: true,
            detectedIntent: 'farewell'
        };
    }

    // 2. Greetings
    if (/^(?:hello|hi|hey|namaskara|namaste|good morning|good afternoon|good evening)\b/i.test(lower) || /^(?:हाय|हेलो|नमस्ते|नमस्कार|ಹಲೋ|ನಮಸ್ಕಾರ)/u.test(lower)) {
        const namePart = (customerName && customerName !== 'Customer') ? ` ${customerName}` : '';
        return {
            spokenResponse: assistantGreeting(session.language),
            detectedIntent: 'greeting'
        };
    }

    // 3. Customer Booking Inquiries ("What are my bookings?", "Status of my booking", "Who is coming?")
    if (/\b(my booking|my bookings|my appointment|my appointments|check my booking|status of my|did anyone accept|who is coming|when is the|show my bookings|any bookings|active booking)\b/i.test(lower)) {
        const inlinePhone = extractPhoneNumber(text);
        const activePhone = inlinePhone || customerPhone;

        if (!activePhone) {
            draft.pendingIntent = 'ask_phone_for_bookings';
            return {
                spokenResponse: "Please tell me your 10-digit mobile number so I can look up your bookings.",
                detectedIntent: 'ask_customer_phone'
            };
        }

        const allJobs = DB.getJobsByCustomer(activePhone) || [];
        actionsPerformed.push(`Retrieved ${allJobs.length} bookings for customer ${activePhone}`);

        if (allJobs.length === 0) {
            return {
                spokenResponse: "You don't have any bookings yet. Would you like me to find a verified specialist in your area?",
                detectedIntent: 'customer_bookings_empty',
                toolExecuted: 'getCustomerBookings',
                toolResult: { count: 0 }
            };
        }

        const active = allJobs.filter(j => j.status !== 'Cancelled' && j.status !== 'Completed');
        if (active.length === 0) {
            const last = allJobs[0];
            return {
                spokenResponse: `You have no active pending bookings. Your last service was ${last.service} (Job #${last.id}) marked as ${last.status}.`,
                detectedIntent: 'customer_bookings_past',
                toolExecuted: 'getCustomerBookings',
                toolResult: { count: allJobs.length, bookings: allJobs }
            };
        }

        const bookingDescription = booking => {
            const workerInfo = booking.worker_name ? `with ${booking.worker_name}` : 'broadcasting to nearby verified specialists';
            return `${booking.service} (Job #${booking.id}) on ${booking.requested_date} at ${booking.requested_time} ${workerInfo}, status ${booking.status}`;
        };
        if (active.length > 1) {
            const shown = active.slice(0, 3).map(bookingDescription).join('; ');
            const remaining = active.length > 3 ? ` Check your dashboard for the other ${active.length - 3} bookings.` : ' Check your dashboard for all of them.';
            return {
                spokenResponse: `You have ${active.length} active bookings: ${shown}.${remaining}`,
                detectedIntent: 'customer_bookings_active',
                toolExecuted: 'getCustomerBookings',
                toolResult: { count: active.length, bookings: active }
            };
        }

        const b = active[0];
        const workerInfo = b.worker_name ? `with ${b.worker_name}` : 'broadcasting to nearby verified specialists';
        return {
            spokenResponse: `You have a booking for ${b.service} (Job #${b.id}) on ${b.requested_date} at ${b.requested_time} ${workerInfo}. Current status is ${b.status}.`,
            detectedIntent: 'customer_bookings_active',
            toolExecuted: 'getCustomerBookings',
            toolResult: { count: active.length, bookings: active }
        };
    }

    // 4. Cancel Booking ("Cancel my booking GS-1234", "Cancel job")
    const cancelMatch = lower.match(/\b(?:cancel|abort)\s+(?:my\s+)?(?:booking|job)?\s*([A-Za-z0-9-]+)?\b/i);
    if (cancelMatch && (cancelMatch[1] || lower.includes('cancel'))) {
        const jobIdCandidate = (text.match(/GS-\d{4}/i) || [])[0] || cancelMatch[1];
        if (jobIdCandidate) {
            const job = DB.getJobById(jobIdCandidate.toUpperCase());
            if (job) {
                DB.updateJobStatus(job.id, 'Cancelled');
                actionsPerformed.push(`Cancelled Job #${job.id} for customer`);
                return {
                    spokenResponse: `Job #${job.id} for ${job.service} has been cancelled successfully.`,
                    detectedIntent: 'cancel_job',
                    toolExecuted: 'cancelJob',
                    toolResult: { jobId: job.id, status: 'Cancelled' }
                };
            }
        }
    }

    // 5. Check if awaiting booking confirmation
    if (draft.awaiting_booking_confirmation && draft.pending_booking) {
        if (/^(yes|yeah|yep|sure|correct|right|okay|ok|confirm|confirmed|book|book it|proceed|do it|ha|haudu|yes please|ಹೌದು|ಹೌದಾ|हाँ|हां)(?:\b|\s|$)/iu.test(lower)) {
            const pb = { ...draft.pending_booking };
            // If the caller names a specific worker while confirming (for
            // example “ಹೌದು ರಾಮುಗೆ ಬುಕ್ ಮಾಡಿ”), bind that worker now instead
            // of silently creating the previously broadcast request.
            const workerNameAliases = {
                ramu: ['ರಾಮು', 'रामू'], priya: ['ಪ್ರಿಯಾ', 'प्रिया'], kiran: ['ಕಿರಣ್', 'किरण'],
                saurav: ['ಸೌರವ್', 'सौरव', 'सौरव್'], john: ['ಜಾನ್', 'जॉन'], zainab: ['ಜೈನಬ್', 'जैनब']
            };
            const namedWorker = (DB.getAllWorkers() || []).find(w => {
                if (!w.name || (city && w.city && String(w.city).toLowerCase() !== String(city).toLowerCase())) return false;
                const key = String(w.name).toLowerCase().split(/\s+/)[0];
                return lower.includes(String(w.name).toLowerCase()) || (workerNameAliases[key] || []).some(alias => text.includes(alias));
            });
            if (namedWorker) {
                pb.workerId = namedWorker.id;
                pb.workerName = namedWorker.name;
                pb.workerPhone = namedWorker.phone;
                pb.price = namedWorker.price || pb.price;
            }
            const activePhone = customerPhone || extractPhoneNumber(text) || pb.customer_phone || '9876543210';
            if (!pb.workerId) {
                const availableWorkers = getAvailableWorkersForSlot(DB.getAllWorkers({ city, service: pb.service }) || [], pb.date, pb.time, pb.requested_end_time);
                if (availableWorkers.length === 0) {
                    draft.awaiting_booking_confirmation = false;
                    draft.pending_booking = null;
                    return {
                        spokenResponse: `No verified specialists are available in ${city} for ${pb.date} at ${pb.time}. Would you like to try another time?`,
                        detectedIntent: 'booking_conflict_no_availability'
                    };
                }
            }
            const createResult = await AI_TOOLS.createJob({
                customer_id: session.customerId || null,
                customer_phone: activePhone,
                customer_name: customerName,
                workerId: pb.workerId,
                workerName: pb.workerName || `Finding verified ${pb.service}s...`,
                workerPhone: pb.workerPhone,
                service: pb.service,
                problem_description: `Service request for ${pb.service} booked via GigSync AI.`,
                location: 'Town Area',
                city,
                requestedDate: pb.date,
                requestedTime: pb.time,
                requestedEndTime: pb.requested_end_time || null,
                budget: `₹${pb.price}`,
                status: pb.workerId ? 'Confirmed' : 'Requested'
            });

            if (createResult.status === 'conflict') {
                draft.awaiting_booking_confirmation = false;
                draft.pending_booking = null;
                return {
                    spokenResponse: createResult.message || `No verified specialists are available in ${city} for ${pb.date} at ${pb.time}. Would you like to try another time?`,
                    detectedIntent: 'booking_conflict_no_availability',
                    toolExecuted: 'createJob',
                    toolResult: createResult
                };
            }
            const newJob = createResult.job;

            actionsPerformed.push(`Confirmed and created Job #${newJob.id} for customer ${activePhone}`);
            draft.awaiting_booking_confirmation = false;
            draft.pending_booking = null;

            const responseText = pb.workerName
                ? `Done! Your booking #${newJob.id} for ${pb.service} with ${pb.workerName} on ${pb.date} at ${pb.time} is confirmed! Estimated cost is ₹${pb.price}.`
                : `Done! Your service request #${newJob.id} for ${pb.service} on ${pb.date} at ${pb.time} has been dispatched to nearby verified specialists in ${city}.`;

            return {
                spokenResponse: responseText,
                detectedIntent: 'create_booking',
                toolExecuted: 'createJob',
                toolResult: { job: newJob, success: true }
            };
        } else if (/^(no|nope|wrong|cancel|don't|dont|stop|not now)\b/i.test(lower)) {
            draft.awaiting_booking_confirmation = false;
            draft.pending_booking = null;
            return {
                spokenResponse: "No problem! Booking request cancelled. What else can I help you with?",
                detectedIntent: 'cancel_booking_draft'
            };
        }
    }

    // 6. Booking / Hiring Request ("Book Priya tomorrow at 10 AM", "I want to book an electrician", "Book a plumber for leaking tap", "tomorrow I need worker at 8 am to clean my house")
    const isDirectBooking = /\b(?:book|hire|schedule|send|request|get me an?|need to book)\b/i.test(lower)
        || /(?:ಬುಕ್|ಬುಕಿಂಗ್|ನೇಮಿಸಿ|ಹುಡುಕಿ|बुक|बुकिंग|बुला|भर्ती)/u.test(text);
    const extractedTrade = extractTradeAndService(text);
    let extractedTime = extractTimeWindow(text);
    const extractedDate = extractAvailabilityDate(text) || (lower.includes('today') ? 'Today' : (lower.includes('tomorrow') ? 'Tomorrow' : null));

    // Complete a previously captured start time with the end time supplied on
    // the next turn. A single time is never treated as a full booking slot.
        if (draft.awaiting_booking_end && extractedTime) {
            const pendingStart = draft.pending_booking_start;
            const end = extractedTime.endTime || extractedTime.startTime;
            extractedTime = { startTime: pendingStart.startTime, endTime: end, startDisplay: pendingStart.startDisplay, endDisplay: extractedTime.endDisplay || extractedTime.startDisplay };
            draft.awaiting_booking_end = false;
            draft.pending_booking_start = null;
        }

    // Check if customer mentions a specific worker's name
    const allWorkers = DB.getAllWorkers({ city }) || [];
    let targetWorker = null;
    for (const w of allWorkers) {
        if (w.name && lower.includes(w.name.toLowerCase())) {
            targetWorker = w;
            break;
        }
    }

    if (isDirectBooking || draft.awaiting_booking_end || (draft.service && (extractedDate || extractedTime)) || (targetWorker && (extractedDate || extractedTime || isDirectBooking)) || (extractedTrade && (extractedDate || extractedTime || targetWorker))) {
        const service = (targetWorker && targetWorker.trade) || extractedTrade || draft.service || 'General Service';
        const date = extractedDate || draft.date || 'Tomorrow';
        if (!extractedTime && !draft.time) {
            // Preserve the service/date while asking for the missing slot so a
            // follow-up such as “9 ರಿಂದ 4” completes the same request.
            draft.service = service;
            draft.date = date;
            draft.workerId = targetWorker ? targetWorker.id : (draft.workerId || null);
            draft.workerName = targetWorker ? targetWorker.name : (draft.workerName || null);
            draft.workerPhone = targetWorker ? targetWorker.phone : (draft.workerPhone || null);
            return { spokenResponse: session.language === 'KN' ? 'ಯಾವ ಸಮಯಕ್ಕೆ ಬುಕ್ ಮಾಡಬೇಕು? ಪ್ರಾರಂಭ ಮತ್ತು ಅಂತ್ಯದ ಸಮಯ ಎರಡನ್ನೂ ಹೇಳಿ.' : session.language === 'HN' ? 'किस समय बुक करना है? कृपया शुरू और समाप्ति दोनों समय बताइए।' : 'What time should I book? Please tell me both the start and end time.', detectedIntent: 'ask_booking_time' };
        }
        if (extractedTime && extractedTime.startTime === extractedTime.endTime) {
            draft.awaiting_booking_end = true;
            draft.pending_booking_start = { startTime: extractedTime.startTime, startDisplay: extractedTime.startDisplay };
            draft.service = service;
            draft.date = date;
            draft.workerId = targetWorker ? targetWorker.id : (draft.workerId || null);
            draft.workerName = targetWorker ? targetWorker.name : (draft.workerName || null);
            draft.workerPhone = targetWorker ? targetWorker.phone : (draft.workerPhone || null);
            return { spokenResponse: session.language === 'KN' ? `ಪ್ರಾರಂಭ ಸಮಯ ${extractedTime.startDisplay}. ಯಾವ ಸಮಯದವರೆಗೆ ಲಭ್ಯವಿರುತ್ತಾರೆ?` : session.language === 'HN' ? `शुरू का समय ${extractedTime.startDisplay} है। समाप्ति का समय क्या होगा?` : `The start time is ${extractedTime.startDisplay}. What is the end time?`, detectedIntent: 'ask_booking_end_time' };
        }
        const time = extractedTime
            ? (extractedTime.startTime !== extractedTime.endTime
                ? `${extractedTime.startDisplay || extractedTime.startTime} to ${extractedTime.endDisplay || extractedTime.endTime}`
                : (extractedTime.startDisplay || extractedTime.startTime))
            : draft.time;
        const requestedEndTime = extractedTime && extractedTime.endTime && extractedTime.endTime !== extractedTime.startTime
            ? extractedTime.endTime
            : (draft.pending_booking && draft.pending_booking.requested_end_time) || null;
        const workerId = targetWorker ? targetWorker.id : (draft.workerId || null);
        const workerName = targetWorker ? targetWorker.name : (draft.workerName || null);
        const workerPhone = targetWorker ? targetWorker.phone : (draft.workerPhone || null);
        const price = targetWorker ? targetWorker.price : 350;

        // For a service-only request, show matching workers before asking for
        // confirmation. This preserves the requested slot while allowing the
        // caller to say “book Ramu” and bind that exact database record.
        if (!workerId) {
            const matchingWorkers = DB.getAllWorkers({ city, service }) || [];
            const availableWorkers = getAvailableWorkersForSlot(matchingWorkers, date, time, requestedEndTime);
            if (availableWorkers.length > 0) {
                const topWorkers = availableWorkers.slice(0, 3);
                const selectedWorker = topWorkers[0];
                const descriptions = topWorkers.map(w => `${w.name} (${w.trade}, ★${w.rating || 5.0}, ₹${w.price || 300})`).join(', ');
                const slotLabel = date && time ? ` for ${date} at ${time}` : '';
                draft.pending_booking = {
                    service, date, time,
                    workerId: selectedWorker.id,
                    workerName: selectedWorker.name,
                    workerPhone: selectedWorker.phone,
                    price: selectedWorker.price || price,
                    customer_phone: customerPhone || '9876543210',
                    requested_end_time: requestedEndTime
                };
                draft.awaiting_booking_confirmation = true;
                return {
                    spokenResponse: `We have verified specialists in ${city}${slotLabel}: ${descriptions}. Would you like me to book one for you?`,
                    detectedIntent: 'find_workers_for_booking',
                    toolExecuted: 'findWorkers',
                    toolResult: { count: availableWorkers.length, workers: topWorkers }
                };
            } else if (date && time) {
                draft.awaiting_booking_confirmation = false;
                draft.pending_booking = null;
                return {
                    spokenResponse: `No verified specialists are available in ${city} for ${date} at ${time}. Would you like to try another time?`,
                    detectedIntent: 'find_workers_empty'
                };
            }
        }

        // If direct booking with worker, run conflict check
        if (workerId) {
            const workerAvailabilityForDate = DB.getWorkerAvailability(workerId, date) || [];
            if (workerAvailabilityForDate.length === 0) {
                return {
                    spokenResponse: `${workerName} has not set working hours for ${date}. Would you like to pick another date or see other available ${service}s?`,
                    detectedIntent: 'booking_conflict_not_available'
                };
            }
            const conflict = DB.checkScheduleConflict(workerId, date, time, requestedEndTime);
            if (conflict === 'NotAvailable') {
                return {
                    spokenResponse: `${workerName} has not set working hours for ${date}. Would you like to pick another date or see other available ${service}s?`,
                    detectedIntent: 'booking_conflict_not_available'
                };
            } else if (conflict === 'OutsideHours') {
                return {
                    spokenResponse: `${time} is outside ${workerName}'s working hours on ${date}. Would you like to choose an earlier or later time slot?`,
                    detectedIntent: 'booking_conflict_outside_hours'
                };
            } else if (conflict === 'JobConflict') {
                return {
                    spokenResponse: `${workerName} already has another booking around ${time} on ${date}. Would you like to select another time?`,
                    detectedIntent: 'booking_conflict_job_conflict'
                };
            }
        }

        const activePhone = customerPhone || extractPhoneNumber(text) || '9876543210';
        draft.pending_booking = {
            service,
            date,
            time,
            requested_end_time: requestedEndTime,
            workerId,
            workerName,
            workerPhone,
            price,
            customer_phone: activePhone
        };
        draft.awaiting_booking_confirmation = true;

        const confirmPrompt = workerName
            ? `Just to confirm: you want to book ${service} with ${workerName} for ${date} at ${time}, estimated cost ₹${price}. Shall I go ahead and book this?`
            : `Just to confirm: you want ${service} on ${date} at ${time}, estimated cost ₹${price}. Shall I go ahead and book this?`;

        return {
            spokenResponse: confirmPrompt,
            detectedIntent: 'ask_booking_confirmation'
        };
    }

    // 6. Specialist Discovery ("I need an electrician", "Who is available?", "Find a plumber in Ramanagara")
    if (extractedTrade || /\b(electrician|plumber|carpenter|mechanic|painter|technician|mason|tailor|welder|cleaner|appliance|specialist|specialists|workers|worker)\b/i.test(lower)) {
        const trade = extractedTrade || (lower.match(/\b(electrician|plumber|carpenter|mechanic|painter|technician|mason|tailor|welder)\b/i) || [])[0] || '';
        // Preserve a service-only request for the next turn when the caller
        // supplies the date/time after seeing or hearing the initial prompt.
        if (trade) draft.service = trade;
        if (extractedDate) draft.date = extractedDate;
        if (trade && !extractedDate && !extractedTime && !targetWorker) {
            return {
                spokenResponse: session.language === 'KN'
                    ? 'ಯಾವ ದಿನ ಮತ್ತು ಯಾವ ಸಮಯಕ್ಕೆ ಬುಕ್ ಮಾಡಬೇಕು? ಪ್ರಾರಂಭ ಮತ್ತು ಅಂತ್ಯದ ಸಮಯ ಎರಡನ್ನೂ ಹೇಳಿ.'
                    : session.language === 'HN'
                        ? 'किस दिन और किस समय बुक करना है? कृपया शुरू और समाप्ति दोनों समय बताइए।'
                        : 'What date and time should I book? Please tell me both the start and end time.',
                detectedIntent: 'ask_booking_date_time'
            };
        }
        let matchingWorkers = DB.getAllWorkers({ city, service: trade || null });
        if (/\b(lower price|lowest price|cheapest|cheaper|budget|कम कीमत|सस्ता|ಕಡಿಮೆ ಬೆಲೆ|ಅಗ್ಗ)\b/iu.test(lower)) {
            matchingWorkers = matchingWorkers.slice().sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
        }
        const discoveryDate = extractedDate || draft.date;
        const discoveryTime = extractedTime
            ? (extractedTime.startTime !== extractedTime.endTime
                ? `${extractedTime.startDisplay || extractedTime.startTime} to ${extractedTime.endDisplay || extractedTime.endTime}`
                : (extractedTime.startDisplay || extractedTime.startTime))
            : draft.time;
        const discoveryEndTime = extractedTime && extractedTime.endTime && extractedTime.endTime !== extractedTime.startTime
            ? extractedTime.endTime
            : null;
        const availableWorkers = getAvailableWorkersForSlot(matchingWorkers, discoveryDate, discoveryTime, discoveryEndTime);
        actionsPerformed.push(`Searched specialists for trade '${trade}' in '${city}': ${availableWorkers.length} available`);

        if (availableWorkers.length === 0) {
            return {
                spokenResponse: trade
                    ? `No verified ${trade}s are available in ${city} for that time. Would you like to try another time?`
                    : `No verified specialists are available in ${city} for that time. Would you like to try another time?`,
                detectedIntent: 'find_workers_empty'
            };
        }

        const topWorkers = availableWorkers.slice(0, 3);
        const descriptions = topWorkers.map(w => `${w.name} (${w.trade}, ★${w.rating || 5.0}, ₹${w.price || 300})`).join(', ');
        const slotDate = discoveryDate || null;
        const slotLabel = slotDate && discoveryTime ? ` for ${slotDate} at ${discoveryTime}` : '';

        return {
            spokenResponse: `We have verified specialists in ${city}${slotLabel}: ${descriptions}. Would you like me to book one for you?`,
            detectedIntent: 'find_workers',
            toolExecuted: 'findWorkers',
            toolResult: { count: availableWorkers.length, workers: topWorkers }
        };
    }

    // 7. Pricing and FAQ Inquiries
    if (/\b(how much|price|cost|charges|rate|rates|service list|services|what is gigsync)\b/i.test(lower)) {
        return {
            spokenResponse: "GigSync connects you with verified local electricians, plumbers, carpenters, painters, and mechanics across Karnataka. Standard visit rates start from ₹300.",
            detectedIntent: 'general_info'
        };
    }

    // 8. General Customer Guidance
    return {
        spokenResponse: `I'm here to help you find and book verified specialists in ${city}. What service do you need today? For example, say "I need an electrician tomorrow" or "Clean my house tomorrow at 8 AM".`,
        detectedIntent: 'customer_help'
    };
}

// =============================================================================
// 4B. DEDICATED WORKER VOICE & CHAT ASSISTANT
// =============================================================================
async function processWorkerTurn(session, text, actionsPerformed) {
    if (!session.workerDraft || typeof session.workerDraft !== 'object') {
        session.workerDraft = {};
    }
    const draft = session.workerDraft;
    const rawPhone = (session.callerPhone || '').replace(/\D/g, '');
    const workerPhone = rawPhone.length >= 10 ? rawPhone.slice(-10) : (rawPhone || null);
    if (draft.name === undefined) draft.name = null;
    if (draft.job_role === undefined) draft.job_role = null;
    if (draft.phone === undefined) draft.phone = workerPhone;
    if (draft.availability_date === undefined) draft.availability_date = null;
    if (draft.start_time === undefined) draft.start_time = null;
    if (draft.end_time === undefined) draft.end_time = null;
    if (draft.start_display === undefined) draft.start_display = null;
    if (draft.end_display === undefined) draft.end_display = null;
    if (draft.password === undefined) draft.password = null;
    if (draft.last_asked_field === undefined) draft.last_asked_field = null;
    if (draft.completed === undefined) draft.completed = false;
    if (draft.awaiting_confirmation === undefined) draft.awaiting_confirmation = false;
    const lower = text.toLowerCase().trim();

    // Personal-profile read-back must be handled before generic onboarding or
    // availability prompts. Match all three supported scripts and use the
    // verified phone from the logged-in session/database.
    const isProfileQuery = /\b(?:my\s+(?:details|profile|information|profile details|personal details|personal information|account details)|what details do you have about me|give me my (?:personal )?details|who am i registered as|what is my phone|what is my name|what trade am i|what is my job|what is my profession|what do i do)\b/i.test(lower)
        || /(?:मेरी जानकारी|मेरी प्रोफाइल|मेरे विवरण|मेरे डिटेल|मैं किस नाम से|मेरा फोन|मेरा नाम|मेरा काम|मेरा पेशा|मैं क्या काम करता|मेरी जानकारी बताइए)/u.test(text)
        || /(?:ನನ್ನ ವಿವರ|ನನ್ನ ಪ್ರೊಫೈಲ್|ನನ್ನ ಮಾಹಿತಿ|ನನ್ನ ಡೀಟೇಲ್ಸ್|ನನ್ನ ಹೆಸರು|ನನ್ನ ಫೋನ್|ನನ್ನ ಕೆಲಸ|ನನ್ನ ವೃತ್ತಿ|ನಾನು ಯಾವ ಕೆಲಸ|ನನ್ನ ವಿವರಗಳನ್ನು ಹೇಳಿ)/u.test(text);
    if (isProfileQuery) {
        const phone = draft.phone || workerPhone || session.callerPhone;
        const worker = phone ? DB.getWorkerByPhone(phone) : null;
        return {
            spokenResponse: localizedWorkerProfile(worker, session.language || 'EN'),
            detectedIntent: 'worker_profile_details',
            toolExecuted: 'getWorkerProfile',
            toolResult: worker ? { status: 'success', dataAvailable: true, profile: worker } : { status: 'not_registered', dataAvailable: false }
        };
    }

    // An anonymous terminal cannot know which account was selected. Do not
    // start a new registration just because the caller asks this question.
    if (/\b(?:which|what)\s+(?:account|profile).*(?:logged|login|signed)|\b(?:logged|login|signed).*(?:account|profile)\b/i.test(lower)) {
        const knownPhone = draft.phone || workerPhone;
        const worker = knownPhone ? DB.getWorkerByPhone(knownPhone) : null;
        if (worker) return { spokenResponse: `You are using the worker account for ${worker.name}, registered as ${getTradePersonNoun(worker.trade)}.`, detectedIntent: 'account_identity' };
        return { spokenResponse: 'No worker account is linked to this terminal yet. Tell me your 10-digit registered phone number, or say "sign me up" to create one.', detectedIntent: 'account_identity_unknown' };
    }

    // 1. Gratitude & Call Ending
    if (/\b(thank you|thanks|thank you so much|dhanyavada|dhanyavadagalu|shukriya)\b/i.test(lower) ||
        (/\b(bye|goodbye|that's all|thats all|that is all|nothing else|nothing more)\b/i.test(lower) && lower.split(/\s+/).length <= 5)) {
        actionsPerformed.push('Closed call upon gratitude/goodbye');
        return {
            spokenResponse: "You're welcome! Feel free to reach out anytime. Have a great day!",
            shouldEndCall: true,
            detectedIntent: 'farewell'
        };
    }

    // 1b. Greetings
    if (/^(hello|hi|hey|namaskara|namaste|good morning|good afternoon|good evening|हाय|हेलो|नमस्ते|ಹಲೋ|ನಮಸ್ಕಾರ)\b/iu.test(lower) && lower.split(/\s+/).length <= 6) {
        const namePart = (session.callerName && session.callerName !== 'Specialist' && session.callerName !== 'User') ? ` ${session.callerName}` : '';
        return {
            spokenResponse: assistantGreeting(session.language),
            detectedIntent: 'greeting'
        };
    }

    // 2a. Next Job Inquiry
    if (/\b(next job|next customer|upcoming job|what is my next|who is my next)\b/i.test(lower)) {
        const phone = draft.phone || workerPhone;
        const res = AI_TOOLS.getWorkerNextJob({ workerPhone: phone });
        if (res.status === 'success' && res.job) {
            return {
                spokenResponse: `Your next job is with ${res.job.customerName || 'customer'} for ${res.job.service} on ${res.job.requestedDate} at ${res.job.requestedTime} in ${res.job.location || 'Town Area'}.`,
                detectedIntent: 'worker_next_job',
                toolExecuted: 'getWorkerNextJob',
                toolResult: res
            };
        } else {
            return {
                spokenResponse: "You don't have any upcoming jobs right now.",
                detectedIntent: 'worker_next_job',
                toolExecuted: 'getWorkerNextJob',
                toolResult: res
            };
        }
    }

    // 2b. Available Opportunities / Job Requests Inquiry
    if (/\b(available jobs|new jobs|job requests|anyone looking for|jobs near me|work near me|any work)\b/i.test(lower)) {
        const phone = draft.phone || workerPhone;
        const worker = phone ? DB.getWorkerByPhone(phone) : null;
        const trade = draft.job_role || (worker ? worker.trade : null);
        const city = session.city || (worker ? worker.city : 'Ramanagara');
        const opps = (DB.getAvailableJobsForWorker(trade, city) || []).filter(job =>
            !worker || DB.checkScheduleConflict(worker.id, job.requested_date, job.requested_time, job.requested_end_time) !== 'JobConflict'
        );
        if (opps.length === 0) {
            return {
                spokenResponse: trade ? `There are currently no new open job requests for ${trade} in ${city}.` : `There are no new open job requests in ${city} right now.`,
                detectedIntent: 'available_job_requests',
                toolExecuted: 'getAvailableJobRequests',
                toolResult: { count: 0 }
            };
        } else {
            const visible = opps.slice(0, 3);
            const descriptions = visible.map(job => `${job.service} in ${job.location || city} on ${job.requested_date} (${job.budget || '₹300'})`).join('; ');
            const more = opps.length > visible.length
                ? ` There are ${opps.length - visible.length} more; please check your dashboard for the rest.`
                : ' You can also check your dashboard for all open requests.';
            return {
                spokenResponse: `There ${opps.length === 1 ? 'is' : 'are'} ${opps.length} open request${opps.length === 1 ? '' : 's'}: ${descriptions}.${more}`,
                detectedIntent: 'available_job_requests',
                toolExecuted: 'getAvailableJobRequests',
                toolResult: { count: opps.length, opportunities: opps }
            };
        }
    }

    // 2c. Booking Inquiries
    const isBookingQuery = /\b(did\s+anyone\s+book\s+me|has\s+anyone\s+booked\s+me|anyone\s+book(ed)?\s+me|booked\s+me|book\s+me|have\s+(a\s+|any\s+)?booking|have\s+any\s+bookings|any\s+booking|any\s+bookings|am\s+i\s+booked|do\s+i\s+have\s+(a\s+|any\s+)?(job|booking|customer)|check\s+my\s+booking|my\s+booking|my\s+bookings|when\s+is\s+my\s+booking|who\s+booked\s+me|who\s+is\s+my\s+customer)\b/i.test(lower)
        || /(?:क्या\s+कल|किसी\s+ने).*(?:बुक|बुकिंग|मुझे)/u.test(text)
        || /(?:ಯಾರಾದರೂ|ಯಾರಾದ್ರೂ).*(?:ಬುಕ್|ಬುಕಿಂಗ್|ನಮಗೆ|ನನ್ನ)/u.test(text)
        || /(?:बुक|ಬುಕ್).*(?:मुझे|ನಮಗೆ|ನನ್ನ)/u.test(text);
    const isWaitingForBookingPhone = draft.last_asked_field === 'phone_for_booking';

    if (isBookingQuery || isWaitingForBookingPhone) {
        const inlinePhone = extractPhoneNumber(text);
        if (inlinePhone) draft.phone = inlinePhone;
        const phone = draft.phone || (session.callerPhone && session.callerPhone !== 'anonymous' ? session.callerPhone : null);
        if (!phone) {
            draft.last_asked_field = 'phone_for_booking';
            return {
                spokenResponse: "Please tell me your phone number to check your bookings.",
                detectedIntent: 'ask_phone_for_booking'
            };
        }
        draft.last_asked_field = null;

        const allJobs = DB.getJobsByWorker(phone) || [];
        const activeBookings = allJobs.filter(j => ['Confirmed', 'Requested', 'Accepted', 'In Progress', 'On the Way'].includes(j.status));
        actionsPerformed.push(`Queried bookings for worker ${phone}: ${activeBookings.length} found`);

        if (activeBookings.length === 0) {
            return {
                spokenResponse: "You don't have any bookings yet.",
                detectedIntent: 'booking_inquiry',
                toolExecuted: 'getWorkerBookings',
                toolResult: { count: 0 }
            };
        } else if (activeBookings.length === 1) {
            const b = activeBookings[0];
            const dateStr = b.requested_date || 'tomorrow';
            const timeStr = b.requested_time || '2 PM to 4 PM';
            const serviceStr = b.service ? ('an ' + b.service.toLowerCase() + ' repair') : 'a service request';
            return {
                spokenResponse: `Yes. You have a booking ${dateStr.toLowerCase()} from ${timeStr} for ${serviceStr}. The customer may contact you regarding the job.`,
                detectedIntent: 'booking_inquiry',
                toolExecuted: 'getWorkerBookings',
                toolResult: { count: 1, bookings: activeBookings }
            };
        } else {
            const b1 = activeBookings[0];
            const b2 = activeBookings[1];
            return {
                spokenResponse: `Yes. You have ${activeBookings.length} bookings. ${b1.requested_date.toLowerCase()} from ${b1.requested_time} and ${b2.requested_date.toLowerCase()} from ${b2.requested_time}. All your bookings are automatically listed under your Assigned Jobs section on your partner dashboard.`,
                detectedIntent: 'booking_inquiry',
                toolExecuted: 'getWorkerBookings',
                toolResult: { count: activeBookings.length, bookings: activeBookings }
            };
        }
    }

    // 3A.2 Dashboard Visibility Inquiry ("why is it not visible on my dashboard?", "where can I see my bookings?")
    if (/\b(not visible|why is it not visible|where is it visible|how to see on dashboard|not showing on dashboard|display all my bookings|show all bookings)\b/i.test(lower)) {
        return {
            spokenResponse: "All your bookings across all dates — including Today, Tomorrow, and upcoming slots — are automatically displayed under your Assigned Jobs section and Bookings Schedule tab on your partner dashboard.",
            detectedIntent: 'dashboard_visibility_inquiry'
        };
    }

    // 3B. Accept Open Job Intent ("can I accept it?", "can you accept them all for me", "accept job", "accept all", "you said 3 right? is this only 1?")
    const isAcceptQuery = /\b(accept|can i accept|take job|accept job|accept request|take this job|i want to accept|accept all|accept them|accept them all)\b/i.test(lower) ||
                          /\b(you said \d+|is this only|why only|how many accepted|did you accept all|why only 1|why is this 1)\b/i.test(lower);

    if (isAcceptQuery) {
        const phone = draft.phone || workerPhone;
        const worker = phone ? DB.getWorkerByPhone(phone) : null;
        if (worker) {
            const isMultiAccept = /\b(all|them|both|every|all 3|all 2|all 4|all 5|them all)\b/i.test(lower) || /\b(you said \d+|is this only|why only)\b/i.test(lower);
            const openRequests = DB.getAvailableJobsForWorker(worker.trade, worker.city) || [];

            if (openRequests.length === 0) {
                return {
                    spokenResponse: "There are currently no open job requests waiting to be accepted in your area.",
                    detectedIntent: 'accept_job_none'
                };
            }

            const acceptedJobs = [];
            const clashingJobs = [];

            const processList = isMultiAccept ? openRequests : [openRequests[0]];

            for (const targetJob of processList) {
                // Schedule Conflict Check: Check if worker already has a booking at this requested date & time
                const conflict = DB.checkScheduleConflict(worker.id, targetJob.requested_date, targetJob.requested_time, targetJob.requested_end_time);
                if (conflict === 'JobConflict') {
                    clashingJobs.push(targetJob);
                    actionsPerformed.push(`Skipped Job #${targetJob.id} (${targetJob.requested_time}) due to schedule conflict for worker ${worker.name}`);
                } else {
                    const updated = DB.updateJobStatus(targetJob.id, 'Accepted', worker.id, worker.name, worker.phone);
                    if (updated) {
                        acceptedJobs.push(updated);
                        actionsPerformed.push(`Worker ${worker.name} accepted Job #${targetJob.id} (${targetJob.service})`);
                    }
                }
            }

            if (isMultiAccept) {
                if (acceptedJobs.length > 0 && clashingJobs.length === 0) {
                    const jobListStr = acceptedJobs.map(j => `#${j.id}`).join(', ');
                    return {
                        spokenResponse: `Great! I have accepted all ${acceptedJobs.length} open job requests (${jobListStr}) for you. The customers have been notified.`,
                        detectedIntent: 'accept_job_multi_success',
                        toolExecuted: 'updateJobStatusByWorker',
                        toolResult: { count: acceptedJobs.length, jobs: acceptedJobs }
                    };
                } else if (acceptedJobs.length > 0 && clashingJobs.length > 0) {
                    const acceptedStr = acceptedJobs.map(j => `#${j.id}`).join(', ');
                    const clashingStr = clashingJobs.map(j => `#${j.id} at ${j.requested_time}`).join(', ');
                    return {
                        spokenResponse: `I accepted ${acceptedJobs.length} job request(s) (${acceptedStr}). However, ${clashingJobs.length} request(s) (${clashingStr}) were not accepted because the requested time clashes with your existing bookings.`,
                        detectedIntent: 'accept_job_partial_conflict',
                        toolExecuted: 'updateJobStatusByWorker',
                        toolResult: { accepted: acceptedJobs, clashing: clashingJobs }
                    };
                } else {
                    const clashingStr = clashingJobs.map(j => `#${j.id} on ${j.requested_date} at ${j.requested_time}`).join(', ');
                    return {
                        spokenResponse: `I could not accept the job request(s) (${clashingStr}) because the time clashes with your existing bookings.`,
                        detectedIntent: 'accept_job_all_clash'
                    };
                }
            } else {
                // Single Job Acceptance
                if (acceptedJobs.length > 0) {
                    const targetJob = acceptedJobs[0];
                    return {
                        spokenResponse: `Great! Job #${targetJob.id} for ${targetJob.service} in ${targetJob.location || targetJob.city} has been assigned to you. The customer has been notified.`,
                        detectedIntent: 'accept_job',
                        toolExecuted: 'updateJobStatusByWorker',
                        toolResult: { job: targetJob, success: true }
                    };
                } else if (clashingJobs.length > 0) {
                    const clash = clashingJobs[0];
                    return {
                        spokenResponse: `Job #${clash.id} for ${clash.service} on ${clash.requested_date} at ${clash.requested_time} clashes with your existing booking. I cannot accept it automatically.`,
                        detectedIntent: 'accept_job_conflict'
                    };
                }
            }
        }
    }

    // 3. Direct Account & Availability Inquiries
    if (/\b(what is my job|what is my profession|what trade am i|what do i do)\b/i.test(lower)) {
        const phone = draft.phone || session.callerPhone;
        const worker = phone ? DB.getWorkerByPhone(phone) : null;
        const trade = draft.job_role || (worker && worker.trade);
        if (trade) {
            const personNoun = getTradePersonNoun(trade);
            return { spokenResponse: `You are registered as ${personNoun}.`, detectedIntent: 'query_job_role' };
        } else {
            return { spokenResponse: "You haven't registered a job role yet. What type of work do you do?", detectedIntent: 'ask_job_role' };
        }
    }
    if (/\b(what time am i available|what are my hours|what is my timing|what are my timings)\b/i.test(lower)) {
        const phone = draft.phone || session.callerPhone;
        const availList = phone ? (DB.getWorkerAvailability(phone) || []) : [];
        const slot = availList[0];
        if (slot) {
            return { spokenResponse: `You are available ${slot.date_str.toLowerCase()} from ${slot.start_time} to ${slot.end_time}.`, detectedIntent: 'query_availability' };
        } else if (draft.availability_date && draft.start_time && draft.end_time) {
            return { spokenResponse: `You are available ${draft.availability_date.toLowerCase()} from ${draft.start_display || draft.start_time} to ${draft.end_display || draft.end_time}.`, detectedIntent: 'query_availability' };
        } else {
            return { spokenResponse: "You don't have any availability hours saved yet. What time are you available?", detectedIntent: 'ask_availability' };
        }
    }
    if (/\b(what date am i available|what day am i available)\b/i.test(lower)) {
        const phone = draft.phone || session.callerPhone;
        const availList = phone ? (DB.getWorkerAvailability(phone) || []) : [];
        const slot = availList[0];
        if (slot) {
            return { spokenResponse: `You are available on ${slot.date_str.toLowerCase()}.`, detectedIntent: 'query_date' };
        } else if (draft.availability_date) {
            return { spokenResponse: `You are available on ${draft.availability_date.toLowerCase()}.`, detectedIntent: 'query_date' };
        } else {
            return { spokenResponse: "You don't have an available date saved yet. What date are you available?", detectedIntent: 'ask_date' };
        }
    }

    // 4. Earnings Inquiry
    if (/\b(how much did i earn|my earnings|my total earning|how much money|check my earnings)\b/i.test(lower)) {
        const phone = draft.phone || workerPhone;
        const worker = phone ? DB.getWorkerByPhone(phone) : null;
        if (worker) {
            const earnings = DB.getWorkerEarnings(worker.id);
            const count = earnings.totalCompletedJobs ?? (Array.isArray(earnings.completedJobs) ? earnings.completedJobs.length : 0);
            const total = earnings.totalEarnings || 0;
            return {
                spokenResponse: `You have completed ${count} jobs with total earnings of ₹${total}.`,
                detectedIntent: 'query_earnings',
                toolExecuted: 'getWorkerEarnings',
                toolResult: earnings
            };
        } else {
            return {
                spokenResponse: "You have completed 0 jobs so far. Your total earnings are ₹0.",
                detectedIntent: 'query_earnings',
                toolExecuted: 'getWorkerEarnings',
                toolResult: { totalEarnings: 0, totalCompletedJobs: 0, completedJobs: [] }
            };
        }
    }

    // 5. Awaiting Confirmation Response Check
    // Returning workers have a separate draft so no availability change is
    // written merely because speech recognition heard a time fragment.
    if (draft.awaiting_availability_confirmation) {
        if (/^(yes|yeah|yep|sure|correct|right|okay|ok|done|ha|haudu|confirm|confirmed|ಹೌದು|ಹೌದಾ|हाँ|हां|हांबना)(?:\b|\s|$)/iu.test(lower)) {
            const pending = draft.pending_availability;
            const worker = pending && DB.getWorkerByPhone(draft.phone || workerPhone);
            if (!pending || !worker) {
                draft.awaiting_availability_confirmation = false;
                return { spokenResponse: 'I could not find those availability details. Please tell me the date and your working hours.', detectedIntent: 'availability_draft_missing' };
            }
            const saveRes = DB.setWorkerAvailabilitySlot({
                workerId: worker.id, workerPhone: worker.phone, trade: worker.trade,
                dateStr: pending.date, startTime: pending.startTime, endTime: pending.endTime,
                isAvailable: true,
                pattern: pending.pattern || 'once',
                daysOfWeek: pending.daysOfWeek || [],
                rangeStart: pending.rangeStart || pending.date,
                rangeEnd: pending.rangeEnd || null
            });
            draft.awaiting_availability_confirmation = false;
            draft.pending_availability = null;
            actionsPerformed.push(`Updated availability for worker ${worker.name}: ${pending.date} ${pending.startTime}-${pending.endTime}`);
            const savedLabel = formatAvailabilityPatternLabel(pending.pattern || 'once', pending.rangeStart || pending.date, pending.daysOfWeek || []);
            return {
                spokenResponse: `Done. Your availability has been updated for ${savedLabel} from ${pending.startDisplay} to ${pending.endDisplay}.`,
                detectedIntent: 'update_availability', toolExecuted: 'updateWorkerAvailability', toolResult: saveRes
            };
        }
        if (/^(no|nope|wrong|change|not correct|cancel)\b/i.test(lower)) {
            draft.awaiting_availability_confirmation = false;
            draft.pending_availability = null;
            draft.last_asked_field = 'availability_start';
            return { spokenResponse: 'No problem. What time do you want to start?', detectedIntent: 'ask_availability_start' };
        }
    }

    if (draft.awaiting_confirmation) {
        if (/^(yes|yeah|yep|sure|correct|right|okay|ok|done|ha|haudu|yes please|confirm|confirmed|ಹೌದು|ಹೌದಾ|हाँ|हां|हांबना)(?:\b|\s|$)/iu.test(lower)) {
            const writeResult = DB.registerOrUpdateWorker({
                name: draft.name,
                phone: draft.phone,
                job_role: draft.job_role,
                city: session.city || 'Ramanagara',
                password: draft.password
            });

            if (writeResult && writeResult.persisted) {
                const savedWorker = DB.getWorkerByPhone(draft.phone);
                const savedTrade = (savedWorker && savedWorker.trade) || draft.job_role;
                const savedNoun = getTradePersonNoun(savedTrade);
                const savedTradeLabel = String(savedNoun).replace(/^an?\s+/i, '');
                actionsPerformed.push(`Saved worker details to database and Firebase for ${draft.name} (${draft.phone})`);
                draft.last_asked_field = null;
                draft.completed = true;
                draft.awaiting_confirmation = false;
                // Terminal callers start anonymous. Preserve the newly verified
                // number on the session so follow-up questions use this profile.
                session.callerPhone = draft.phone;
                session.callerRole = 'worker';
                session.callerName = savedWorker ? savedWorker.name : draft.name;
                session.voiceSignupComplete = true;
                return {
                    spokenResponse: session.isVoiceCall
                        ? (session.language === 'KN'
                            ? `ಆಯಿತು, ${draft.name}. ನಿಮ್ಮ ${savedTradeLabel} ಕೆಲಸಗಾರರ ಖಾತೆ ಯಶಸ್ವಿಯಾಗಿ ರಚಿಸಲಾಗಿದೆ. ಹಿಂದಿರುಗಿ ಫೋನ್ ಸಂಖ್ಯೆ ಮತ್ತು ಪಾಸ್‌ವರ್ಡ್ ಬಳಸಿ ಲಾಗಿನ್ ಮಾಡಿ, ನಂತರ ಡ್ಯಾಶ್‌ಬೋರ್ಡ್‌ನಲ್ಲಿ ಲಭ್ಯತೆಯನ್ನು ಹೊಂದಿಸಿ.`
                            : session.language === 'HN'
                                ? `हो गया, ${draft.name}. आपका ${savedTradeLabel} कामगार खाता सफलतापूर्वक बन गया है। वापस जाकर फोन नंबर और पासवर्ड से लॉगिन करें, फिर डैशबोर्ड में अपनी उपलब्धता सेट करें।`
                                : `Done, ${draft.name}. Your ${savedTradeLabel} worker account was created successfully. Please go back and log in with your phone number and password, then set your availability from your worker dashboard.`)
                        : `Done. Your details have been updated successfully. You are registered as ${savedNoun}.`,
                    detectedIntent: 'worker_updated',
                    toolExecuted: 'registerOrUpdateWorker',
                    toolResult: writeResult
                };
            } else {
                return {
                    spokenResponse: "I couldn't save your details right now. Please try again.",
                    detectedIntent: 'save_failed',
                    toolExecuted: 'registerOrUpdateWorker',
                    toolResult: writeResult
                };
            }
        } else if (/^(no|nope|wrong|change|not correct|cancel)\b/i.test(lower)) {
            draft.awaiting_confirmation = false;
            draft.start_time = null;
            draft.end_time = null;
            draft.last_asked_field = 'time';
            return {
                spokenResponse: "No problem. What time are you available?",
                detectedIntent: 'ask_time'
            };
        }
    }

    // 6. Registered Worker Availability Quick Update
    const phone = draft.phone || (session.callerPhone && session.callerPhone !== 'anonymous' ? session.callerPhone : null);
    const existingWorker = phone ? DB.getWorkerByPhone(phone) : null;
    if (existingWorker) {
        if (!draft.name) draft.name = existingWorker.name;
        if (!draft.job_role) draft.job_role = existingWorker.trade;
        if (!draft.phone) draft.phone = existingWorker.phone;
    }

    const extractedTime = extractTimeWindow(text);
    const extractedDate = extractAvailabilityDate(text) || (lower.includes('tomorrow') ? 'Tomorrow' : (lower.includes('today') ? 'Today' : null));
    const dailyAvailability = /(?:\bdaily\b|\bevery day\b|\beach day\b|रोज|हर दिन|प्रतिदिन|ಪ್ರತಿ ದಿನ|ಪ್ರತಿದಿನ)/iu.test(text);
    const weeklyAvailability = /(?:\bweekly\b|\bevery week\b|\beach week\b|\bweekdays?\b|\bweekend(s)?\b|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)/iu.test(text);
    const weekdayNumbers = weeklyAvailability ? extractWeekdays(text) : [];
    const pattern = dailyAvailability ? 'daily' : (weeklyAvailability ? 'weekly' : 'once');
    const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const isWeekdayLabel = value => {
        const lowerValue = String(value || '').toLowerCase();
        return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sun', 'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat']
            .includes(lowerValue);
    };

    if (existingWorker && (extractedTime || extractedDate || draft.pending_availability || dailyAvailability || weeklyAvailability)) {
        // An explicit new availability statement replaces an abandoned draft
        // from an earlier turn/session; it is never interpreted as its end.
        const startsNewAvailability = /\b(available|availability|working hours|work from)\b/i.test(lower);
        const pending = startsNewAvailability ? {} : (draft.pending_availability || {});
        if (startsNewAvailability) draft.pending_availability = null;
        // Recurring patterns need a concrete range start for expansion; Today is
        // the default anchor while pattern='daily' or pattern='weekly' makes it recur.
        const recurringStart = pattern === 'weekly' && extractedDate && isWeekdayLabel(extractedDate)
            ? (pending.date || 'Today')
            : (extractedDate || pending.date || 'Today');
        const dateStr = recurringStart;

        if (!extractedTime) {
            if (pattern === 'weekly' && weekdayNumbers.length === 0 && !(pending.daysOfWeek && pending.daysOfWeek.length)) {
                draft.pending_availability = { ...pending, date: dateStr, pattern };
                draft.last_asked_field = 'availability_days';
                return { spokenResponse: 'Which day or days of the week should I save this for?', detectedIntent: 'ask_availability_days' };
            }
            draft.pending_availability = { ...pending, date: dateStr, pattern, daysOfWeek: weekdayNumbers.length ? weekdayNumbers : (pending.daysOfWeek || []) };
            draft.last_asked_field = 'availability_start';
            return { spokenResponse: 'What time will you start being available?', detectedIntent: 'ask_availability_start' };
        }

        // A one-point expression ("10 o'clock" / "10 AM") is a start time,
        // not an availability range. Preserve it and ask only for the end.
        if (extractedTime.startTime === extractedTime.endTime && !pending.startTime) {
            draft.pending_availability = {
                date: dateStr,
                pattern,
                daysOfWeek: weekdayNumbers,
                startTime: extractedTime.startTime,
                startDisplay: extractedTime.startDisplay
            };
            draft.last_asked_field = 'availability_end';
            if (pattern === 'weekly' && weekdayNumbers.length === 0) {
                draft.last_asked_field = 'availability_days';
                return { spokenResponse: 'Which day or days of the week should I save this for?', detectedIntent: 'ask_availability_days' };
            }
            return { spokenResponse: `You will start at ${extractedTime.startDisplay}. Until what time will you be available?`, detectedIntent: 'ask_availability_end' };
        }

        const startTime = pending.startTime || extractedTime.startTime;
        const startDisplay = pending.startDisplay || extractedTime.startDisplay;
        const endTime = pending.startTime ? extractedTime.startTime : extractedTime.endTime;
        const endDisplay = pending.startTime ? extractedTime.startDisplay : extractedTime.endDisplay;
        if (pattern === 'weekly' && weekdayNumbers.length === 0 && !(pending.daysOfWeek && pending.daysOfWeek.length)) {
            draft.pending_availability = { date: dateStr, pattern, startTime, endTime, startDisplay, endDisplay };
            draft.last_asked_field = 'availability_days';
            return { spokenResponse: 'Which day or days of the week should I save this for?', detectedIntent: 'ask_availability_days' };
        }
        draft.pending_availability = {
            date: dateStr,
            pattern,
            daysOfWeek: weekdayNumbers.length ? weekdayNumbers : (pending.daysOfWeek || []),
            rangeStart: dateStr,
            startTime,
            endTime,
            startDisplay,
            endDisplay
        };
        draft.awaiting_availability_confirmation = true;
        draft.last_asked_field = 'availability_confirmation';
        const effectiveDays = weekdayNumbers.length ? weekdayNumbers : (pending.daysOfWeek || []);
        const scheduleLabel = pattern === 'daily'
            ? 'every day'
            : pattern === 'weekly' && effectiveDays.length
                ? `every ${effectiveDays.map(d => weekdayNames[d]).join(', ')}`
                : dateStr;
        return {
            spokenResponse: `Just to confirm: you are available ${scheduleLabel} from ${startDisplay} to ${endDisplay}. Shall I save this?`,
            detectedIntent: 'ask_availability_confirmation'
        };
    }

    // If already registered worker, provide helpful assistant prompt instead of re-asking onboarding
    if (existingWorker) {
        if (session.isVoiceCall) {
            const loginPrompt = session.language === 'KN'
                ? 'ನಿಮ್ಮ ಖಾತೆ ಯಶಸ್ವಿಯಾಗಿ ರಚಿಸಲಾಗಿದೆ. ದಯವಿಟ್ಟು ಫೋನ್ ಸಂಖ್ಯೆ ಮತ್ತು ಪಾಸ್‌ವರ್ಡ್ ಬಳಸಿ ಲಾಗಿನ್ ಮಾಡಿ.'
                : session.language === 'HN'
                    ? 'आपका खाता सफलतापूर्वक बन गया है। कृपया फोन नंबर और पासवर्ड से लॉगिन करें।'
                    : 'Your account was created successfully. Please log in with your phone number and password.';
            return { spokenResponse: loginPrompt, detectedIntent: 'login_required_after_signup' };
        }
        return {
            spokenResponse: `I'm here to assist you, ${existingWorker.name}. You can say "Did anyone book me?", "Set availability tomorrow 9 to 5", "Check my earnings", or "What is my next job?".`,
            detectedIntent: 'worker_help'
        };
    }

    // 7. New Worker Onboarding Extraction Loop (for unregistered workers)
    // Name
    const collectingPassword = draft.last_asked_field === 'password';
    const extractedName = (collectingPassword || (draft.name && draft.last_asked_field !== 'name')) ? null : extractCallerName(text);
    if (extractedName) {
        draft.name = extractedName;
        session.callerName = extractedName;
    } else if (draft.last_asked_field === 'name') {
        const hasNativeScript = /[\u0900-\u097F\u0C80-\u0CFF]/u.test(text);
        const cleanName = text.replace(/^(my name is|name is|i am|i'm|this is|it's|its|call me|मेरा नाम|मेरा नाम है|ನನ್ನ ಹೆಸರು|ನನ್ನ ಹೆಸರು ಏನು)\s*/iu, '').trim()
            .replace(hasNativeScript ? /[^\p{L}\s]/gu : /[^a-zA-Z\s]/g, '').trim();
        const nonNames = ['hello', 'hi', 'yes', 'no', 'ok', 'okay', 'sure', 'electrician', 'plumber', 'carpenter', 'mechanic', 'tomorrow', 'today'];
        if (cleanName.length >= 2 && !nonNames.includes(cleanName.toLowerCase())) {
            const formatted = cleanName.charAt(0).toUpperCase() + cleanName.slice(1).toLowerCase();
            draft.name = formatted;
            session.callerName = formatted;
        }
    }

    // Phone
    const extractedPhone = collectingPassword ? null : extractPhoneNumber(text);
    if (extractedPhone) {
        draft.phone = extractedPhone;
        session.callerPhone = extractedPhone;
    }

    // Job Role
    const extractedTrade = collectingPassword ? null : extractTradeAndService(text);
    if (extractedTrade) {
        draft.job_role = extractedTrade;
    } else if (draft.last_asked_field === 'job_role') {
        const rawTrade = extractTradeAndService(text);
        if (rawTrade) draft.job_role = rawTrade;
    }

    // Date
    if (!collectingPassword && extractedDate) {
        draft.availability_date = extractedDate;
    } else if (draft.last_asked_field === 'availability_date') {
        const d = extractAvailabilityDate(text);
        if (d) draft.availability_date = d;
    }

    // Time
    if (!collectingPassword && extractedTime) {
        const isSingleTime = extractedTime.startTime === extractedTime.endTime;
        if (isSingleTime && draft.start_time && !draft.end_time) {
            // The caller is answering the precise follow-up: "until when?"
            draft.end_time = extractedTime.startTime;
            draft.end_display = extractedTime.startDisplay;
        } else if (isSingleTime) {
            // A single clock time is never an availability range.
            draft.start_time = extractedTime.startTime;
            draft.start_display = extractedTime.startDisplay;
            draft.end_time = null;
            draft.end_display = null;
        } else {
            draft.start_time = extractedTime.startTime;
            draft.end_time = extractedTime.endTime;
            draft.start_display = extractedTime.startDisplay;
            draft.end_display = extractedTime.endDisplay;
        }
    }

    // Password is collected explicitly for new worker accounts. Never infer or
    // invent one: the caller must provide it so they can log in later.
    if (!draft.password && draft.last_asked_field === 'password') {
        const candidate = text.trim().replace(/^(my password is|password is|password|पासवर्ड है|पासवर्ड|ಪಾಸ್‌ವರ್ಡ್)\s*/iu, '').trim();
        if (candidate.length >= 6 && !/\s/.test(candidate)) draft.password = candidate;
    }

    // Determine next missing field
    if (!draft.name) {
        draft.last_asked_field = 'name';
        return { spokenResponse: workerPrompt(session, 'name', 'What is your name?'), detectedIntent: 'ask_name' };
    }
    if (!draft.job_role) {
        draft.last_asked_field = 'job_role';
        return { spokenResponse: workerPrompt(session, 'trade', 'What type of work do you do?'), detectedIntent: 'ask_job_role' };
    }
    if (!draft.phone || draft.phone.length < 10) {
        draft.last_asked_field = 'phone';
        return { spokenResponse: workerPrompt(session, 'phone', 'What is your 10-digit phone number?'), detectedIntent: 'ask_phone' };
    }
    if (!session.isVoiceCall && !draft.availability_date) {
        draft.last_asked_field = 'availability_date';
        return { spokenResponse: workerPrompt(session, 'date', 'What date are you available?'), detectedIntent: 'ask_date' };
    }
    if (!session.isVoiceCall && (!draft.start_time || !draft.end_time)) {
        const askingForEnd = Boolean(draft.start_time && !draft.end_time);
        draft.last_asked_field = askingForEnd ? 'end_time' : 'time';
        return {
            spokenResponse: askingForEnd
                ? `${draft.start_display || draft.start_time}. ${workerPrompt(session, 'end', 'Until what time will you be available?')}`
                : workerPrompt(session, 'time', 'What time are you available? Please tell me both the start and end time.'),
            detectedIntent: askingForEnd ? 'ask_end_time' : 'ask_time'
        };
    }

    if (!draft.password) {
        draft.last_asked_field = 'password';
        return { spokenResponse: workerPrompt(session, 'password', 'Please create a password with at least 6 characters for your worker login.'), detectedIntent: 'ask_password' };
    }

    // All required fields are present -> confirm
    const timeDisplay = draft.start_time && draft.end_time
        ? `${draft.start_display || draft.start_time} to ${draft.end_display || draft.end_time}` : null;
    const personNoun = getTradePersonNoun(draft.job_role);
    const tradeText = String(draft.job_role || '').toLowerCase();
    const localizedNoun = session.language === 'HN'
        ? (tradeText.includes('tailor') ? 'दर्जी' : tradeText.includes('plumb') ? 'प्लंबर' : tradeText.includes('carp') ? 'बढ़ई' : tradeText.includes('mechan') ? 'मैकेनिक' : tradeText.includes('paint') ? 'पेंटर' : tradeText.includes('clean') ? 'सफाईकर्मी' : personNoun)
        : session.language === 'KN'
            ? (tradeText.includes('tailor') ? 'ಟೈಲರ್' : tradeText.includes('plumb') ? 'ಪ್ಲಂಬರ್' : tradeText.includes('carp') ? 'ಕಾರ್ಪೆಂಟರ್' : tradeText.includes('mechan') ? 'ಮೆಕ್ಯಾನಿಕ್' : tradeText.includes('paint') ? 'ಪೇಂಟರ್' : tradeText.includes('clean') ? 'ಕ್ಲೀನರ್' : personNoun)
            : personNoun;
    draft.awaiting_confirmation = true;
    draft.last_asked_field = 'confirmation';
    return {
        spokenResponse: session.isVoiceCall
            ? (session.language === 'HN'
                ? `पुष्टि करें: आपका नाम ${draft.name} है और आप ${localizedNoun} के रूप में पंजीकरण कर रहे हैं। क्या मैं आपका कामगार खाता बनाऊँ?`
                : session.language === 'KN'
                    ? `ದೃಢೀಕರಿಸಿ: ನಿಮ್ಮ ಹೆಸರು ${draft.name} ಮತ್ತು ನೀವು ${localizedNoun} ಆಗಿ ನೋಂದಾಯಿಸಿಕೊಳ್ಳುತ್ತಿದ್ದೀರಿ. ನಿಮ್ಮ ಕೆಲಸಗಾರರ ಖಾತೆಯನ್ನು ರಚಿಸಬೇಕೇ?`
                    : `Just to confirm, your name is ${draft.name} and you are registering as ${localizedNoun}. Shall I create your worker account?`)
            : `Just to confirm, ${draft.name}, you are ${personNoun} and you are available ${draft.availability_date.toLowerCase()} from ${timeDisplay}. Is that correct?`,
        detectedIntent: 'ask_confirmation'
    };
}

// =============================================================================
// 5. INTELLIGENT MULTI-TURN CONVERSATIONAL PROCESSOR
// =============================================================================
class ContextAwareVoiceAgent {
    async processTurn(optsOrSession, maybeText) {
        return this.processCallTurn(optsOrSession, maybeText);
    }

    async processCallTurn(optsOrSession, maybeText) {
        let sessionId, callerPhone, callerRole, callerName, city, speechText, isVoiceCall, portal, language;

        if (typeof optsOrSession === 'string' && typeof maybeText === 'string') {
            sessionId = optsOrSession;
            speechText = maybeText;
        } else if (optsOrSession && typeof optsOrSession === 'object' && typeof maybeText === 'string') {
            sessionId = optsOrSession.sessionId || optsOrSession.callerPhone || 'default_session';
            callerPhone = optsOrSession.callerPhone;
            callerRole = optsOrSession.callerRole || (optsOrSession.portal === 'worker' ? 'worker' : 'customer');
            callerName = optsOrSession.callerName || 'User';
            city = optsOrSession.city || 'Ramanagara';
            isVoiceCall = optsOrSession.isVoiceCall;
            portal = optsOrSession.portal;
            language = optsOrSession.language || 'EN';
            speechText = maybeText;
        } else if (optsOrSession && typeof optsOrSession === 'object') {
            sessionId = optsOrSession.sessionId || optsOrSession.callerPhone || 'default_session';
            callerPhone = optsOrSession.callerPhone;
            callerRole = optsOrSession.callerRole || (optsOrSession.portal === 'worker' ? 'worker' : 'customer');
            callerName = optsOrSession.callerName || 'User';
            city = optsOrSession.city || 'Ramanagara';
            isVoiceCall = optsOrSession.isVoiceCall;
            portal = optsOrSession.portal;
            language = optsOrSession.language || 'EN';
            speechText = optsOrSession.speechText || optsOrSession.text || '';
        } else {
            speechText = String(optsOrSession || '');
        }

        const text = (speechText || '').trim();
        const targetCity = extractLocationEntity(text, city || 'Ramanagara');

        const session = (optsOrSession && optsOrSession.context && optsOrSession.history)
            ? optsOrSession
            : sessionManager.getSession(sessionId, { callerPhone, callerRole, callerName, city: targetCity, language, portal, isVoiceCall });

        session.city = targetCity;
        session.isVoiceCall = Boolean(isVoiceCall || portal === 'terminal' || session.isVoiceCall);
        // A signed-in dashboard session is authenticated; the login-only
        // message is reserved for the anonymous post-signup terminal state.
        if (callerPhone && String(callerPhone).toLowerCase() !== 'anonymous' && callerRole === 'worker') {
            session.voiceSignupComplete = false;
        }
        if (!(portal === 'terminal' && session.terminalAccountChoice)) {
            session.callerRole = callerRole || session.callerRole || 'customer';
        }
        session.context.currentLocation = targetCity;
        const languageValue = String(language || '').trim().toUpperCase();
        const requestedLanguage = /^(KN|KANNADA)$/.test(languageValue) ? 'KN'
            : (/^(HN|HI|HINDI)$/.test(languageValue) ? 'HN'
                : (/^(EN|ENGLISH)$/.test(languageValue) ? 'EN' : null));
        // An explicit language button selection wins on every turn. If the
        // client has not selected a native language (or is still on English),
        // use the script in the transcript as a safe fallback.
        const spokenLanguage = /[\u0900-\u097F]/u.test(text) ? 'HN' : (/[\u0C80-\u0CFF]/u.test(text) ? 'KN' : null);
        if (requestedLanguage && requestedLanguage !== 'EN') session.language = requestedLanguage;
        else if (spokenLanguage) session.language = spokenLanguage;
        else if (requestedLanguage) session.language = requestedLanguage;
        else session.language = session.language || 'EN';
        sessionManager.addTurn(session, 'user', text);
        let spokenResponse = '';
        const actionsPerformed = [];

        // A new anonymous terminal session must establish whether this is a
        // customer or worker signup before asking for any personal details.
        if (session.isVoiceCall && portal === 'terminal' && !session.terminalAccountChoice) {
            const normalizedChoice = text.toLowerCase().trim();
            // Do not use \b around Indic scripts: JavaScript word boundaries
            // are ASCII-oriented and fail for forms such as ಗ್ರಾಹಕರ/कामगार।
            const workerChoice = /\b(workers?|worker account)\b/i.test(normalizedChoice)
                || ['कामगार', 'कर्मचारी', 'मजदूर', 'ಕೆಲಸಗಾರ', 'ಕೆಲಸಗಾರರ', 'ಕಾರ್ಮಿಕ', 'ಕೆಲಸ ಮಾಡುವ', 'kamgar', 'karmachari', 'mazdoor'].some(term => normalizedChoice.includes(term));
            const customerChoice = /\b(customers?|customer account)\b/i.test(normalizedChoice)
                || ['ग्राहक', 'ग्राहक खाता', 'ग्राहकों', 'ग्राहक का', 'ಗ್ರಾಹಕ', 'ಗ್ರಾಹಕರ', 'ಗ್ರಾಹಕರ ಖಾತೆ', 'grahak', 'graahak', 'customer account'].some(term => normalizedChoice.includes(term));
            if (workerChoice || customerChoice) {
                session.terminalAccountChoice = workerChoice ? 'worker' : 'customer';
                session.callerRole = session.terminalAccountChoice;
                session.workerDraft = { name: null, job_role: null, phone: null, availability_date: null, start_time: null, end_time: null, start_display: null, end_display: null, password: null, last_asked_field: 'name', completed: false, awaiting_confirmation: false };
                session.customerDraft = {};
                const ask = session.terminalAccountChoice === 'worker'
                    ? (session.language === 'KN' ? 'ನಿಮ್ಮ ಹೆಸರು ಏನು?' : session.language === 'HN' ? 'आपका नाम क्या है?' : 'What is your name?')
                    : (session.language === 'KN' ? 'ನಿಮ್ಮ ಹೆಸರು ಏನು?' : session.language === 'HN' ? 'आपका नाम क्या है?' : 'What is your name?');
                spokenResponse = ask;
            } else {
                spokenResponse = session.language === 'KN'
                    ? 'ನಾನು GigSync ನಿಮ್ಮ ಸಹಾಯಕ. ಇಂದು ನೀವು ಯಾವ ರೀತಿಯ ಖಾತೆಯನ್ನು ರಚಿಸಲು ಬಯಸುತ್ತೀರಿ — ಕೆಲಸಗಾರರ ಖಾತೆಯೇ ಅಥವಾ ಗ್ರಾಹಕರ ಖಾತೆಯೇ?'
                    : session.language === 'HN'
                        ? 'मैं GigSync आपका सहायक हूँ। आज आप किस प्रकार का खाता बनाना चाहते हैं — कामगार या ग्राहक?'
                        : "I'm GigSync, your assistant. What type of account would you like to create today — worker or customer?";
            }
            if (spokenResponse) {
                sessionManager.addTurn(session, 'assistant', spokenResponse);
                sessionManager.saveSession(session);
                return { spokenResponse, language: session.language, detectedIntent: 'account_type_selection', actionsPerformed };
            }
        }

        let toolExecuted = null;
        let toolResult = null;
        let detectedIntent = 'unknown';
        let extractedEntities = {};
        let shouldEndCall = false;

        // Profile read-backs are database reads, not generative answers. Run
        // them through the deterministic worker path so Gemini cannot return
        // an English prompt, stale details, or an invented profile after a
        // Kannada/Hindi language switch.
        const profileReadback = session.callerRole === 'worker' && (
            /\b(?:my\s+(?:details|profile|information|profile details|personal details|personal information|account details)|what details do you have about me|give me my (?:personal )?details|who am i registered as|what is my phone|what is my name|what trade am i|what is my job|what is my profession|what do i do)\b/i.test(text)
            || /(?:मेरी जानकारी|मेरी प्रोफाइल|मेरे विवरण|मेरे डिटेल|मैं किस नाम से|मेरा फोन|मेरा नाम|मेरा काम|मेरा पेशा|मैं क्या काम करता|मेरी जानकारी बताइए)/u.test(text)
            || /(?:ನನ್ನ ವಿವರ|ನನ್ನ ಪ್ರೊಫೈಲ್|ನನ್ನ ಮಾಹಿತಿ|ನನ್ನ ಡೀಟೇಲ್ಸ್|ನನ್ನ ಹೆಸರು|ನನ್ನ ಫೋನ್|ನನ್ನ ಕೆಲಸ|ನನ್ನ ವೃತ್ತಿ|ನಾನು ಯಾವ ಕೆಲಸ|ನನ್ನ ವಿವರಗಳನ್ನು ಹೇಳಿ)/u.test(text)
        );
        if (profileReadback) {
            const workerTurn = await processWorkerTurn(session, text, actionsPerformed);
            spokenResponse = workerTurn.spokenResponse;
            toolExecuted = workerTurn.toolExecuted || null;
            toolResult = workerTurn.toolResult || null;
            detectedIntent = workerTurn.detectedIntent || 'worker_profile_details';
        }

        // Availability slot filling is also stateful. Keep follow-up answers
        // (including a bare “yes” or a Kannada/Hindi time phrase) on the local
        // path so Gemini cannot restart the time question or discard the
        // pending start/end values.
        const workerDraftState = session.workerDraft || {};
        const workerAvailabilityTurn = session.callerRole === 'worker' && (
            workerDraftState.awaiting_availability_confirmation || workerDraftState.pending_availability
            || /\b(?:available|availability|working hours|start time|end time|daily|every day|tomorrow|today)\b/i.test(text)
            || /(?:ಲಭ್ಯ|ಲಭ್ಯತೆ|ಕೆಲಸದ ಸಮಯ|ಪ್ರತಿ ದಿನ|ನಾಳೆ|ಇಂದು|ರಿಂದ|ವರೆಗೆ|ನೈನ್|ಫೋರ್|उपलब्ध|उपलब्धता|काम के घंटे|रोज|कल|आज|से|तक|नौ|चार)/u.test(text)
        );
        if (workerAvailabilityTurn && !spokenResponse) {
            const workerTurn = await processWorkerTurn(session, text, actionsPerformed);
            spokenResponse = workerTurn.spokenResponse;
            toolExecuted = workerTurn.toolExecuted || null;
            toolResult = workerTurn.toolResult || null;
            detectedIntent = workerTurn.detectedIntent || 'worker_interaction';
            shouldEndCall = workerTurn.shouldEndCall || false;
        }

        // Customer booking/search turns are stateful database operations. Do
        // not let a generative answer reuse an old service or time (for
        // example, turning 9–4 into 8 AM); the local engine extracts the
        // current utterance and preserves pending booking context exactly.
        const customerTransactionTurn = session.callerRole === 'customer' && (
            /\b(?:book|booking|bookings|hire|schedule|need|find|search|worker|specialist|electrician|plumber|carpenter|mechanic|painter|clean|tomorrow|today|from\s+\d|at\s+\d|show me|near me|cancel)\b/i.test(text)
            || /\d\s*(?:ರಿಂದ|ಇಂದ|ವರೆಗೆ|से|तक|to|till|-)\s*\d/u.test(text)
            || /(?:ಬುಕ್|ಬುಕಿಂಗ್|ಕೆಲಸಗಾರ|ತಜ್ಞ|ಎಲೆಕ್ಟ್ರಿಷಿಯನ್|ಪ್ಲಂಬರ್|ಪ್ಲಂಬಿಂಗ್|ಕಾರ್ಪೆಂಟರ್|ಮೆಕ್ಯಾನಿಕ್|ಪೇಂಟರ್|ನಾಳೆ|ಇಂದು|ನನ್ನ ಬುಕಿಂಗ್|ಹುಡುಕಿ|ಬೇಕು|ಬೇಕಾಗಿತ್ತು)/u.test(text)
            || /(?:बुक|बुकिंग|कामगार|विशेषज्ञ|इलेक्ट्रिशियन|प्लंबर|बढ़ई|मैकेनिक|पेंटर|कल|आज|मेरी बुकिंग|ढूँढ)/u.test(text)
        );
        if (customerTransactionTurn && !spokenResponse) {
            const customerTurn = await processCustomerTurn(session, text, actionsPerformed);
            spokenResponse = customerTurn.spokenResponse;
            toolExecuted = customerTurn.toolExecuted || null;
            toolResult = customerTurn.toolResult || null;
            detectedIntent = customerTurn.detectedIntent || 'customer_interaction';
            shouldEndCall = customerTurn.shouldEndCall || false;
        }

        // 1. Direct Gemini 3.6 Flash Engine Execution
        const geminiClient = spokenResponse ? null : geminiBrain.getClient();
        if (geminiClient) {
            try {
                const geminiTurn = await geminiBrain.processTurn({ session, text });
                if (geminiTurn && geminiTurn.spokenResponse) {
                    const expectedScript = session.language === 'HN' ? /[\u0900-\u097F]/u : session.language === 'KN' ? /[\u0C80-\u0CFF]/u : null;
                    // Never let a successful-but-wrong-language Gemini turn
                    // leak into the call. The deterministic local engine will
                    // provide the selected-language prompt instead.
                    if (!expectedScript || expectedScript.test(geminiTurn.spokenResponse) || process.env.TRANSLATION_SERVICE_URL) {
                        spokenResponse = geminiTurn.spokenResponse;
                        toolExecuted = geminiTurn.toolExecuted || null;
                        toolResult = geminiTurn.toolResult || null;
                        shouldEndCall = geminiTurn.shouldEndCall || false;
                        detectedIntent = toolExecuted ? `gemini_${toolExecuted}` : 'gemini_turn';
                        actionsPerformed.push('Processed turn directly with Gemini AI Engine');
                    }
                }
            } catch (err) {
                console.warn('[AI Agent] Gemini processing warning:', err.message);
            }
        }

        // 2. Backup Local Engine (only if Gemini key is missing or fails)
        if (!spokenResponse) {
            if (session.callerRole === 'worker') {
                const workerTurn = await processWorkerTurn(session, text, actionsPerformed);
                spokenResponse = workerTurn.spokenResponse;
                toolExecuted = workerTurn.toolExecuted || null;
                toolResult = workerTurn.toolResult || null;
                detectedIntent = workerTurn.detectedIntent || 'worker_interaction';
                shouldEndCall = workerTurn.shouldEndCall || false;
            } else {
                const customerTurn = await processCustomerTurn(session, text, actionsPerformed);
                spokenResponse = customerTurn.spokenResponse;
                toolExecuted = customerTurn.toolExecuted || null;
                toolResult = customerTurn.toolResult || null;
                detectedIntent = customerTurn.detectedIntent || 'customer_interaction';
                shouldEndCall = customerTurn.shouldEndCall || false;
            }
        }

        spokenResponse = session.callerRole === 'worker'
            ? localizeWorkerFallback(spokenResponse, session.language)
            : localizeCustomerFallback(spokenResponse, session.language);
        spokenResponse = await translateResponseIfRequired(spokenResponse, session.language);

        // Add assistant turn to session memory
        sessionManager.addTurn(session, 'assistant', spokenResponse);
        sessionManager.saveSession(session);

        // Record real call log in SQLite DB
        DB.logCall({
            callerPhone: session.callerPhone || 'anonymous',
            callerRole: session.callerRole || 'customer',
            transcript: text,
            intentDetected: detectedIntent || toolExecuted || 'interaction',
            actionsTaken: actionsPerformed.join('; '),
            durationSeconds: 10
        });

        console.log(`\n[AI - ${session.callerRole.toUpperCase()}] Transcript:`, text);
        console.log(`[AI - ${session.callerRole.toUpperCase()}] Response:`, spokenResponse);

        return {
            spokenResponse,
            language: session.language || 'EN',
            toolExecuted,
            toolResult,
            detectedIntent,
            extractedEntities,
            actionsPerformed,
            shouldEndCall,
            context: {
                currentService: session.context.currentService,
                currentLocation: session.city,
                pendingIntent: session.context.pendingIntent,
                workersFound: (session.context.lastFoundWorkers || []).length
            }
        };
    }
}


const aiAgent = new ContextAwareVoiceAgent();

module.exports = {
    aiAgent,
    geminiBrain,
    GEMINI_TOOLS_DECLARATIONS,
    GEMINI_MODEL_CHAIN,
    AI_TOOLS,
    sessionManager
};
