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
    async registerOrUpdateWorker({ name, phone, job_role, trade, availability_date, date, start_time, startTime, end_time, endTime, city = 'Ramanagara' }) {
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
            city
        });

        return {
            status: res.persisted ? 'success' : 'error',
            persisted: res.persisted,
            worker: res.worker,
            availability: res.availability
        };
    },

    // 1. Register or Update Worker Profile in Verified Database & Firebase
    async registerWorkerProfile({ name, phone, trade, city = 'Ramanagara', area = 'Town', tools = 'Standard tool kit', price = 300, experienceYears = 2, confirmed = false }) {
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
            experienceYears: Number(experienceYears) || 2
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
    async updateWorkerAvailability({ workerPhone, trade = 'Skilled Specialist', date = 'Tomorrow', startTime, endTime, isAvailable = true, confirmed = false }) {
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
                ? `${date}, ${effectiveStart} to ${effectiveEnd}`
                : `${date} as a day off`;
            return {
                status: 'confirmation_required',
                persisted: false,
                pendingChange: { date, startTime: effectiveStart, endTime: effectiveEnd, isAvailable: Boolean(isAvailable) },
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
            notes: isAvailable ? '' : 'Worker marked this day as not working'
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
            jobs = jobs.filter(j => (j.requested_date || '').toLowerCase() === String(date).toLowerCase());
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
    findWorkers({ service, trade, city = 'Ramanagara' } = {}) {
        const targetTrade = trade || (service && service !== 'all' ? service : undefined);
        const workers = DB.getAllWorkers({
            service: targetTrade,
            city: city,
            isAvailable: true
        });

        return {
            status: 'success',
            count: workers.length,
            workers: workers.map(w => ({
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
    createJob({ customerPhone = '9876543210', customerName = 'Customer', service, problemDescription, location = 'Town Area', city = 'Ramanagara', requestedDate = 'Today', requestedTime = 'Immediate', budget = '₹300', workerId = null, workerName = null, workerPhone = null }) {
        let assignedWorker = null;
        if (workerId) {
            assignedWorker = DB.getWorkerById(workerId);
        } else if (workerPhone) {
            assignedWorker = DB.getWorkerByPhone(workerPhone);
        }

        // Schedule Conflict Prevention Check for Direct Worker Bookings
        if (assignedWorker && requestedDate && requestedTime && requestedDate !== 'Today' && requestedTime !== 'Immediate') {
            const conflict = DB.checkScheduleConflict(assignedWorker.id, requestedDate, requestedTime);
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
        description: 'Set the calling worker\'s working hours for one day, or mark that day off. To set hours you MUST have both a start and an end time — ask the worker for whichever is missing instead of guessing. To mark a day off, pass isAvailable:false and no times are needed ("I don\'t want to work tomorrow"). NOTHING IS SAVED until you call this a second time with confirmed:true, after the worker has agreed to the exact details.',
        parameters: {
            type: 'OBJECT',
            properties: {
                workerPhone: { type: 'STRING', description: 'Filled automatically from the verified caller. Do not ask for it.' },
                trade: { type: 'STRING', description: 'Trade e.g. Electrician. Optional — the stored profession is used when omitted.' },
                date: { type: 'STRING', description: 'Day label: Today, Tomorrow, or a weekday name' },
                startTime: { type: 'STRING', description: 'Start time e.g. 09:00 AM. Required when isAvailable is true.' },
                endTime: { type: 'STRING', description: 'End time e.g. 05:00 PM. Required when isAvailable is true.' },
                isAvailable: { type: 'BOOLEAN', description: 'True = working these hours. False = not working that day (no times required).' },
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
                city: { type: 'STRING', description: 'City name e.g. Ramanagara' }
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
        const timeoutMs = Math.min(Number(process.env.AI_RESPONSE_TIMEOUT_MS) || 1800, 1800);

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
   - Availability Date (e.g. Tomorrow, Today, or a weekday)
   - Working Hours (Start Time & End Time, e.g. 9 AM to 5 PM)
4. Extract all entities present in the user's message.
5. If fields are missing in Current Worker Draft, ask for the next missing field in strict natural order:
   Name -> Phone -> Occupation -> Date -> Working Hours.
   - If only Occupation was given ("I am electrician"): "Sure! What is your name?"
   - If Name was given ("I am Asad"): "Thank you, Asad. What is your 10-digit mobile number?"
   - If Phone was given ("7012280695"): "What type of work do you do?" (or ask for availability if trade is already known)
   - If Trade is known: "What day and hours are you available? For example, tomorrow 9 AM to 5 PM."
6. When all 5 fields are present, summarize and ask for confirmation before saving:
   "Got it. You are [Name], a/an [Occupation], available [Date] from [StartTime] to [EndTime]. Shall I save these details?"
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
        if (defaultData.callerRole && defaultData.callerRole !== session.callerRole) {
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
    if (lower.includes('refrigerator') || lower.includes('fridge') || lower.includes('deep freezer')) {
        return 'Refrigerator Repair';
    }
    if (lower.includes('ac technician') || lower.includes('air conditioner') || lower.includes('split ac') || lower.includes('ac repair') || lower.includes('cooler')) {
        return 'AC & Appliances';
    }
    if (lower.includes('bike mechanic') || lower.includes('two wheeler') || lower.includes('scooter') || lower.includes('motorcycle') || lower.includes('puncture') || lower.includes('bike repair')) {
        return 'Mechanic';
    }
    if (lower.includes('pipe leakage') || lower.includes('leakage repair') || lower.includes('pipe repair') || lower.includes('leaking tap') || lower.includes('tap leak')) {
        return 'Plumbing';
    }

    // Single-word / Core Trade matchers (including common speech-to-text mishears & phonetic variants)
    if (lower.includes('electric') || lower.includes('cliteration') || lower.includes('literation') || lower.includes('elctric') || lower.includes('lectrition') || lower.includes('electritian') || lower.includes('electrition') || lower.includes('electrishan') || lower.includes('fan') || lower.includes('switch') || lower.includes('wire') || lower.includes('current') || lower.includes('power') || lower.includes('bulb') || lower.includes('ಎಲೆಕ್ಟ್ರಿಷಿಯನ್')) {
        return 'Electrical';
    }
    if (lower.includes('plumb') || lower.includes('plamber') || lower.includes('plamer') || lower.includes('pipe') || lower.includes('tap') || lower.includes('leak') || lower.includes('drain') || lower.includes('water') || lower.includes('ಪ್ಲಂಬರ್') || lower.includes('ನೀರು')) {
        return 'Plumbing';
    }
    if (lower.includes('carpenter') || lower.includes('carpanter') || lower.includes('carpnter') || lower.includes('wood') || lower.includes('door') || lower.includes('window') || lower.includes('furniture') || lower.includes('lock') || lower.includes('ಕಾರ್ಪೆಂಟರ್') || lower.includes('ಮರಗೆಲಸ')) {
        return 'Carpentry';
    }
    if (lower.includes('mason') || lower.includes('masonry') || lower.includes('brick') || lower.includes('plaster') || lower.includes('cement') || lower.includes('tile') || lower.includes('ಮೇಸ್ತ್ರಿ') || lower.includes('ಕಟ್ಟಡ')) {
        return 'Masonry & Construction';
    }
    if (lower.includes('tailor') || lower.includes('tailoring') || lower.includes('stitch') || lower.includes('alteration') || lower.includes('blouse') || lower.includes('dressmaker') || lower.includes('ಟೈಲರ್')) {
        return 'Tailoring & Alterations';
    }
    if (lower.includes('welder') || lower.includes('welding') || lower.includes('grill') || lower.includes('fabrication') || lower.includes('metal') || lower.includes('iron gate') || lower.includes('ವೆಲ್ಡರ್')) {
        return 'Welding & Metalwork';
    }
    if (lower.includes('driver') || lower.includes('driving') || lower.includes('chauffeur') || lower.includes('cab driver') || lower.includes('car driver') || lower.includes('ಡ್ರೈವರ್')) {
        return 'Driver Services';
    }
    if (lower.includes('mechanic') || lower.includes('mecanic') || lower.includes('makanic') || lower.includes('breakdown') || lower.includes('engine') || lower.includes('ಮೇಕಾನಿಕ್')) {
        return 'Mechanic';
    }
    if (lower.includes('clean') || lower.includes('maid') || lower.includes('sweep') || lower.includes('wash') || lower.includes('deep clean') || lower.includes('ಕ್ಲೀನಿಂಗ್')) {
        return 'Home Cleaning';
    }
    if (lower.includes('paint') || lower.includes('painter') || lower.includes('whitewash') || lower.includes('wall paint') || lower.includes('ಬಣ್ಣ')) {
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

    // Date Matching with Speech-to-Text Tolerance (tom, tmrw, today today, etc.)
    if (lower.includes('tomorrow morning')) {
        date = 'Tomorrow';
        time = 'Morning (10:00 AM)';
    } else if (lower.includes('tomorrow afternoon')) {
        date = 'Tomorrow';
        time = 'Afternoon (02:00 PM)';
    } else if (lower.includes('tomorrow evening')) {
        date = 'Tomorrow';
        time = 'Evening (05:00 PM)';
    } else if (lower.includes('this morning')) {
        date = 'Today';
        time = 'Morning (10:00 AM)';
    } else if (lower.includes('this afternoon')) {
        date = 'Today';
        time = 'Afternoon (02:00 PM)';
    } else if (lower.includes('this evening')) {
        date = 'Today';
        time = 'Evening (05:00 PM)';
    } else if (lower.includes('tonight') || lower.includes('this night')) {
        date = 'Today';
        time = 'Night (08:00 PM)';
    } else if (lower.includes('next monday') || lower.includes('next week monday')) {
        date = 'Next Monday';
    } else if (lower.includes('saturday') || lower.includes('shanivara')) {
        date = 'Saturday';
    } else if (lower.includes('sunday') || lower.includes('bhanuvara')) {
        date = 'Sunday';
    } else if (lower.includes('monday') || lower.includes('somavara')) {
        date = 'Monday';
    } else if (/\b(tom|tmrw|tomorrow|tomorrow\s+tomorrow|naale|ನಾಳೆ|kal)\b/i.test(lower)) {
        date = 'Tomorrow';
    } else if (/\b(today|today\s+today|now|immediately|urgent|ivathu|ಇವತ್ತು|aaj)\b/i.test(lower)) {
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

function workerPrompt(session, key, english) {
    const lang = session.language || 'EN';
    const prompts = {
        KN: { name: 'ನಿಮ್ಮ ಹೆಸರು ಏನು?', trade: 'ನೀವು ಯಾವ ರೀತಿಯ ಕೆಲಸ ಮಾಡುತ್ತೀರಿ?', phone: 'ನಿಮ್ಮ 10 ಅಂಕಿಯ ಮೊಬೈಲ್ ಸಂಖ್ಯೆಯನ್ನು ಹೇಳಿ.', date: 'ನೀವು ಯಾವ ದಿನ ಲಭ್ಯವಿರುತ್ತೀರಿ?', time: 'ದಯವಿಟ್ಟು ಪ್ರಾರಂಭ ಮತ್ತು ಅಂತ್ಯದ ಸಮಯ ಎರಡನ್ನೂ ಹೇಳಿ.', end: 'ನೀವು ಯಾವ ಸಮಯದವರೆಗೆ ಲಭ್ಯವಿರುತ್ತೀರಿ?', confirm: 'ಈ ವಿವರಗಳನ್ನು ಉಳಿಸಬೇಕೇ?' },
        HN: { name: 'आपका नाम क्या है?', trade: 'आप किस तरह का काम करते हैं?', phone: 'अपना 10 अंकों का मोबाइल नंबर बताइए।', date: 'आप किस तारीख को उपलब्ध हैं?', time: 'कृपया शुरू और समाप्ति दोनों समय बताइए।', end: 'आप किस समय तक उपलब्ध रहेंगे?', confirm: 'क्या मैं इन विवरणों को सहेज दूँ?' }
    };
    return (prompts[lang] && prompts[lang][key]) || english;
}

// Helper to extract start and end time range from natural utterances
function extractTimeRange(text) {
    if (!text) return null;
    let lower = text.toLowerCase()
        // Web Speech commonly returns dotted a.m./p.m.; normalise before parsing.
        .replace(/\ba\s*\.?\s*m\s*\.?(?=\s|$)/g, 'am')
        .replace(/\bp\s*\.?\s*m\s*\.?(?=\s|$)/g, 'pm')
        .replace(/\bo'clock\b/g, '')
        // Hindi and Kannada range connectors, including "9 से 4 बजे तक".
        .replace(/\s*(?:से|तक|ವರೆಗೆ)\s*/gu, ' to ')
        .replace(/\s*(?:ರಿಂದ|ಇಂದ)\s*/gu, ' to ')
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

// Helper to extract caller's stated name (e.g. "My name is Rajesh", "This is Rajesh")
function extractCallerName(text) {
    if (!text) return null;
    const match = text.match(/\b(?:my name is|name is|i am|i'm|this is|call me|hesaru|ಹೆಸರು)\s+([A-Za-z]+)\b/i);
    if (match) {
        const candidate = match[1].trim();
        const nonNames = ['a', 'an', 'the', 'electrician', 'plumber', 'carpenter', 'mechanic', 'available', 'free', 'not', 'looking', 'here', 'calling', 'user', 'there', 'from', 'in', 'on', 'at', 'today', 'tomorrow', 'naale', 'ivathu'];
        if (!nonNames.includes(candidate.toLowerCase()) && candidate.length >= 2) {
            return candidate.charAt(0).toUpperCase() + candidate.slice(1).toLowerCase();
        }
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
    if (/^(hello|hi|hey|namaskara|namaste|good morning|good afternoon|good evening)\b/i.test(lower) && lower.split(/\s+/).length <= 4) {
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
        if (/^(yes|yeah|yep|sure|correct|right|okay|ok|confirm|confirmed|book|book it|proceed|do it|ha|haudu|yes please)\b/i.test(lower)) {
            const pb = draft.pending_booking;
            const activePhone = customerPhone || extractPhoneNumber(text) || pb.customer_phone || '9876543210';
            const newJob = DB.createJob({
                customer_id: session.customerId || null,
                customer_phone: activePhone,
                customer_name: customerName,
                worker_id: pb.workerId,
                worker_name: pb.workerName || `Finding verified ${pb.service}s...`,
                worker_phone: pb.workerPhone,
                service: pb.service,
                problem_description: `Service request for ${pb.service} booked via GigSync AI.`,
                location: 'Town Area',
                city,
                requested_date: pb.date,
                requested_time: pb.time,
                budget: `₹${pb.price}`,
                status: pb.workerId ? 'Confirmed' : 'Requested'
            });

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
    const isDirectBooking = /\b(?:book|hire|schedule|send|request|get me an?|need to book)\b/i.test(lower);
    const extractedTrade = extractTradeAndService(text);
    const extractedTime = extractTimeWindow(text);
    const extractedDate = extractAvailabilityDate(text) || (lower.includes('today') ? 'Today' : (lower.includes('tomorrow') ? 'Tomorrow' : null));

    // Check if customer mentions a specific worker's name
    const allWorkers = DB.getAllWorkers({ city }) || [];
    let targetWorker = null;
    for (const w of allWorkers) {
        if (w.name && lower.includes(w.name.toLowerCase())) {
            targetWorker = w;
            break;
        }
    }

    if (isDirectBooking || (extractedTrade && (extractedDate || extractedTime || targetWorker))) {
        const service = (targetWorker && targetWorker.trade) || extractedTrade || draft.service || 'General Service';
        const date = extractedDate || draft.date || 'Tomorrow';
        const time = (extractedTime && (extractedTime.startDisplay || extractedTime.startTime)) || draft.time || '10:00 AM';
        const workerId = targetWorker ? targetWorker.id : null;
        const workerName = targetWorker ? targetWorker.name : null;
        const workerPhone = targetWorker ? targetWorker.phone : null;
        const price = targetWorker ? targetWorker.price : 350;

        // If direct booking with worker, run conflict check
        if (workerId) {
            const conflict = DB.checkScheduleConflict(workerId, date, time);
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
        const matchingWorkers = DB.getAllWorkers({ city, service: trade || null });
        actionsPerformed.push(`Searched specialists for trade '${trade}' in '${city}': ${matchingWorkers.length} found`);

        if (matchingWorkers.length === 0) {
            return {
                spokenResponse: trade
                    ? `I couldn't find any verified ${trade}s currently registered in ${city}. Would you like to check nearby areas?`
                    : `No verified specialists found in ${city} right now. What type of service do you need?`,
                detectedIntent: 'find_workers_empty'
            };
        }

        const topWorkers = matchingWorkers.slice(0, 3);
        const descriptions = topWorkers.map(w => `${w.name} (${w.trade}, ★${w.rating || 5.0}, ₹${w.price || 300})`).join(', ');

        return {
            spokenResponse: `We have verified specialists in ${city}: ${descriptions}. Would you like me to book one for you?`,
            detectedIntent: 'find_workers',
            toolExecuted: 'findWorkers',
            toolResult: { count: matchingWorkers.length, workers: topWorkers }
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
    if (draft.last_asked_field === undefined) draft.last_asked_field = null;
    if (draft.completed === undefined) draft.completed = false;
    if (draft.awaiting_confirmation === undefined) draft.awaiting_confirmation = false;
    const lower = text.toLowerCase().trim();

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
    if (/^(hello|hi|hey|namaskara|namaste|good morning|good afternoon|good evening)\b/i.test(lower) && lower.split(/\s+/).length <= 4) {
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
        const opps = DB.getAvailableJobsForWorker(trade, city) || [];
        if (opps.length === 0) {
            return {
                spokenResponse: trade ? `There are currently no new open job requests for ${trade} in ${city}.` : `There are no new open job requests in ${city} right now.`,
                detectedIntent: 'available_job_requests',
                toolExecuted: 'getAvailableJobRequests',
                toolResult: { count: 0 }
            };
        } else {
            const first = opps[0];
            return {
                spokenResponse: `There is an open request for ${first.service} in ${first.location || city} on ${first.requested_date} (${first.budget || '₹300'}).`,
                detectedIntent: 'available_job_requests',
                toolExecuted: 'getAvailableJobRequests',
                toolResult: { count: opps.length, opportunities: opps }
            };
        }
    }

    // 2c. Booking Inquiries
    const isBookingQuery = /\b(did\s+anyone\s+book\s+me|has\s+anyone\s+booked\s+me|anyone\s+book(ed)?\s+me|booked\s+me|book\s+me|have\s+(a\s+|any\s+)?booking|have\s+any\s+bookings|any\s+booking|any\s+bookings|am\s+i\s+booked|do\s+i\s+have\s+(a\s+|any\s+)?(job|booking|customer)|check\s+my\s+booking|my\s+booking|my\s+bookings|when\s+is\s+my\s+booking|who\s+booked\s+me|who\s+is\s+my\s+customer)\b/i.test(lower);
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
                const conflict = DB.checkScheduleConflict(worker.id, targetJob.requested_date, targetJob.requested_time);
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
        if (/^(yes|yeah|yep|sure|correct|right|okay|ok|done|ha|haudu|confirm|confirmed)\b/i.test(lower)) {
            const pending = draft.pending_availability;
            const worker = pending && DB.getWorkerByPhone(draft.phone || workerPhone);
            if (!pending || !worker) {
                draft.awaiting_availability_confirmation = false;
                return { spokenResponse: 'I could not find those availability details. Please tell me the date and your working hours.', detectedIntent: 'availability_draft_missing' };
            }
            const saveRes = DB.setWorkerAvailabilitySlot({
                workerId: worker.id, workerPhone: worker.phone, trade: worker.trade,
                dateStr: pending.date, startTime: pending.startTime, endTime: pending.endTime,
                isAvailable: true
            });
            draft.awaiting_availability_confirmation = false;
            draft.pending_availability = null;
            actionsPerformed.push(`Updated availability for worker ${worker.name}: ${pending.date} ${pending.startTime}-${pending.endTime}`);
            return {
                spokenResponse: `Done. Your availability has been updated for ${pending.date} from ${pending.startDisplay} to ${pending.endDisplay}.`,
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
        if (/^(yes|yeah|yep|sure|correct|right|okay|ok|done|ha|haudu|yes please|confirm|confirmed)\b/i.test(lower)) {
            const writeResult = DB.registerOrUpdateWorker({
                name: draft.name,
                phone: draft.phone,
                job_role: draft.job_role,
                availability_date: draft.availability_date,
                start_time: draft.start_time,
                end_time: draft.end_time,
                city: session.city || 'Ramanagara'
            });

            if (writeResult && writeResult.persisted) {
                const savedWorker = DB.getWorkerByPhone(draft.phone);
                const savedTrade = (savedWorker && savedWorker.trade) || draft.job_role;
                const savedNoun = getTradePersonNoun(savedTrade);
                const timeDisplay = `${draft.start_display || draft.start_time} to ${draft.end_display || draft.end_time}`;
                actionsPerformed.push(`Saved worker details to database and Firebase for ${draft.name} (${draft.phone})`);
                draft.last_asked_field = null;
                draft.completed = true;
                draft.awaiting_confirmation = false;
                // Terminal callers start anonymous. Preserve the newly verified
                // number on the session so follow-up questions use this profile.
                session.callerPhone = draft.phone;
                session.callerRole = 'worker';
                session.callerName = savedWorker ? savedWorker.name : draft.name;
                return {
                    spokenResponse: `Done. Your details have been updated successfully. You are registered as ${savedNoun} and available ${draft.availability_date.toLowerCase()} from ${timeDisplay}.`,
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

    if (existingWorker && (extractedTime || extractedDate || draft.pending_availability)) {
        // An explicit new availability statement replaces an abandoned draft
        // from an earlier turn/session; it is never interpreted as its end.
        const startsNewAvailability = /\b(available|availability|working hours|work from)\b/i.test(lower);
        const pending = startsNewAvailability ? {} : (draft.pending_availability || {});
        if (startsNewAvailability) draft.pending_availability = null;
        const dateStr = extractedDate || pending.date || 'Tomorrow';

        if (!extractedTime) {
            draft.pending_availability = { ...pending, date: dateStr };
            draft.last_asked_field = 'availability_start';
            return { spokenResponse: 'What time will you start being available?', detectedIntent: 'ask_availability_start' };
        }

        // A one-point expression ("10 o'clock" / "10 AM") is a start time,
        // not an availability range. Preserve it and ask only for the end.
        if (extractedTime.startTime === extractedTime.endTime && !pending.startTime) {
            draft.pending_availability = {
                date: dateStr, startTime: extractedTime.startTime, startDisplay: extractedTime.startDisplay
            };
            draft.last_asked_field = 'availability_end';
            return { spokenResponse: `You will start at ${extractedTime.startDisplay}. Until what time will you be available?`, detectedIntent: 'ask_availability_end' };
        }

        const startTime = pending.startTime || extractedTime.startTime;
        const startDisplay = pending.startDisplay || extractedTime.startDisplay;
        const endTime = pending.startTime ? extractedTime.startTime : extractedTime.endTime;
        const endDisplay = pending.startTime ? extractedTime.startDisplay : extractedTime.endDisplay;
        draft.pending_availability = { date: dateStr, startTime, endTime, startDisplay, endDisplay };
        draft.awaiting_availability_confirmation = true;
        draft.last_asked_field = 'availability_confirmation';
        return {
            spokenResponse: `Just to confirm: you are available ${dateStr} from ${startDisplay} to ${endDisplay}. Shall I save this?`,
            detectedIntent: 'ask_availability_confirmation'
        };
    }

    // If already registered worker, provide helpful assistant prompt instead of re-asking onboarding
    if (existingWorker) {
        return {
            spokenResponse: `I'm here to assist you, ${existingWorker.name}. You can say "Did anyone book me?", "Set availability tomorrow 9 to 5", "Check my earnings", or "What is my next job?".`,
            detectedIntent: 'worker_help'
        };
    }

    // 7. New Worker Onboarding Extraction Loop (for unregistered workers)
    // Name
    const extractedName = extractCallerName(text);
    if (extractedName) {
        draft.name = extractedName;
        session.callerName = extractedName;
    } else if (draft.last_asked_field === 'name') {
        const cleanName = text.replace(/^(my name is|name is|i am|i'm|this is|it's|its|call me)\s+/i, '').trim().replace(/[^a-zA-Z\s]/g, '').trim();
        const nonNames = ['hello', 'hi', 'yes', 'no', 'ok', 'okay', 'sure', 'electrician', 'plumber', 'carpenter', 'mechanic', 'tomorrow', 'today'];
        if (cleanName.length >= 2 && !nonNames.includes(cleanName.toLowerCase())) {
            const formatted = cleanName.charAt(0).toUpperCase() + cleanName.slice(1).toLowerCase();
            draft.name = formatted;
            session.callerName = formatted;
        }
    }

    // Phone
    const extractedPhone = extractPhoneNumber(text);
    if (extractedPhone) {
        draft.phone = extractedPhone;
        session.callerPhone = extractedPhone;
    }

    // Job Role
    const extractedTrade = extractTradeAndService(text);
    if (extractedTrade) {
        draft.job_role = extractedTrade;
    } else if (draft.last_asked_field === 'job_role') {
        const rawTrade = extractTradeAndService(text);
        if (rawTrade) draft.job_role = rawTrade;
    }

    // Date
    if (extractedDate) {
        draft.availability_date = extractedDate;
    } else if (draft.last_asked_field === 'availability_date') {
        const d = extractAvailabilityDate(text);
        if (d) draft.availability_date = d;
    }

    // Time
    if (extractedTime) {
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
    if (!draft.availability_date) {
        draft.last_asked_field = 'availability_date';
        return { spokenResponse: workerPrompt(session, 'date', 'What date are you available?'), detectedIntent: 'ask_date' };
    }
    if (!draft.start_time || !draft.end_time) {
        const askingForEnd = Boolean(draft.start_time && !draft.end_time);
        draft.last_asked_field = askingForEnd ? 'end_time' : 'time';
        return {
            spokenResponse: askingForEnd
                ? `${draft.start_display || draft.start_time}. ${workerPrompt(session, 'end', 'Until what time will you be available?')}`
                : workerPrompt(session, 'time', 'What time are you available? Please tell me both the start and end time.'),
            detectedIntent: askingForEnd ? 'ask_end_time' : 'ask_time'
        };
    }

    // ALL 5 FIELDS PRESENT -> CONFIRM
    const timeDisplay = `${draft.start_display || draft.start_time} to ${draft.end_display || draft.end_time}`;
    const personNoun = getTradePersonNoun(draft.job_role);
    draft.awaiting_confirmation = true;
    draft.last_asked_field = 'confirmation';
    return {
        spokenResponse: `Just to confirm, ${draft.name}, you are ${personNoun} and you are available ${draft.availability_date.toLowerCase()} from ${timeDisplay}. Is that correct?`,
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
            : sessionManager.getSession(sessionId, { callerPhone, callerRole, callerName, city: targetCity, language });

        session.city = targetCity;
        session.callerRole = callerRole || session.callerRole || 'customer';
        session.context.currentLocation = targetCity;
        session.language = /^(KN|HN|EN)$/i.test(language || '') ? String(language).toUpperCase() : (session.language || 'EN');
        sessionManager.addTurn(session, 'user', text);

        let spokenResponse = '';
        let toolExecuted = null;
        let toolResult = null;
        let detectedIntent = 'unknown';
        let extractedEntities = {};
        let shouldEndCall = false;
        const actionsPerformed = [];

        // 1. Direct Gemini 3.6 Flash Engine Execution
        const geminiClient = geminiBrain.getClient();
        if (geminiClient) {
            try {
                const geminiTurn = await geminiBrain.processTurn({ session, text });
                if (geminiTurn && geminiTurn.spokenResponse) {
                    spokenResponse = geminiTurn.spokenResponse;
                    toolExecuted = geminiTurn.toolExecuted || null;
                    toolResult = geminiTurn.toolResult || null;
                    shouldEndCall = geminiTurn.shouldEndCall || false;
                    detectedIntent = toolExecuted ? `gemini_${toolExecuted}` : 'gemini_turn';
                    actionsPerformed.push('Processed turn directly with Gemini AI Engine');
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
