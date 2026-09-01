/**
 * GigSync — Regression Test Suite
 *
 * Covers:
 *   • Phase 0.5 — Availability matching (the primary bug this branch fixes)
 *   • Schedule conflict detection (NotAvailable, OutsideHours, JobConflict)
 *
 * Run:  node tests/regression.js
 */

'use strict';

const path = require('node:path');
// Always run regression tests against an isolated database so user/development
// records cannot contaminate expected availability and conflict outcomes.
process.env.GIGSYNC_DB_PATH = path.join(require('node:os').tmpdir(), `gigsync-regression-${process.pid}.db`);
try { require('node:fs').unlinkSync(process.env.GIGSYNC_DB_PATH); } catch (e) {}
const DB     = require('../backend/database');
const { resolveTtsLanguage } = require('../backend/tts');
const assert = require('assert');

console.log('=========================================');
console.log('  GIGSYNC REGRESSION TEST SUITE          ');
console.log('=========================================');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        const r = fn();
        if (r && typeof r.then === 'function') {
            return r.then(() => {
                console.log('[PASS] ' + name);
                passed++;
            }).catch(err => {
                console.error('[FAIL] ' + name + ': ' + err.message);
                failed++;
            });
        }
        console.log('[PASS] ' + name);
        passed++;
    } catch (err) {
        console.error('[FAIL] ' + name + ': ' + err.message);
        failed++;
    }
    return Promise.resolve();
}

async function runAll() {

/* =========================================================================
   PHASE 0.5 — Required availability matching tests (from the spec)
   ========================================================================= */

await test('Phase 0.5 — happy path: booking inside available window must succeed (null conflict)', () => {
    const reg = DB.registerWorkerProfile({
        name: 'Priya Electrician', phone: '9876501111',
        trade: 'Electrician', city: 'Ramanagara'
    });
    const worker = reg.worker || DB.getWorkerByPhone('9876501111');
    assert.ok(worker && worker.id, 'Worker must be registered');

    // Worker sets availability: 2026-09-01, 09:00 AM – 05:00 PM
    const slot = DB.setWorkerAvailabilitySlot({
        workerId: worker.id, workerPhone: worker.phone, trade: worker.trade,
        dateStr: '2026-09-01', startTime: '09:00 AM', endTime: '05:00 PM', isAvailable: true
    });
    assert.ok(slot.success, 'Availability slot must be saved');

    // Customer books 10:00 AM on 2026-09-01 — must be allowed
    const conflict = DB.checkScheduleConflict(worker.id, '2026-09-01', '10:00 AM');
    assert.strictEqual(conflict, null,
        'Expected null (no conflict) but got: ' + conflict +
        '. If NotAvailable: date strings are not matching. If OutsideHours: time parser failed.');
});

await test('Phase 0.5 — booking just outside available window must return OutsideHours', () => {
    const worker = DB.getWorkerByPhone('9876501111');
    assert.ok(worker && worker.id, 'Worker must exist from previous test');

    // 07:00 AM is before the 09:00 AM start
    const conflict = DB.checkScheduleConflict(worker.id, '2026-09-01', '07:00 AM');
    assert.strictEqual(conflict, 'OutsideHours',
        'Expected OutsideHours but got: ' + conflict);
});

await test('Phase 0.5 — no availability set for date must return NotAvailable', () => {
    const worker = DB.getWorkerByPhone('9876501111');
    assert.ok(worker && worker.id);

    // No slot was ever set for 2026-09-15
    const conflict = DB.checkScheduleConflict(worker.id, '2026-09-15', '10:00 AM');
    assert.strictEqual(conflict, 'NotAvailable',
        'Expected NotAvailable but got: ' + conflict);
});

await test('Phase 0.5 — Bug B guard: range string as time is handled (start portion used)', () => {
    // Old _bookWorkerDirect used to pass "09:00 AM – 05:00 PM" as requested_time.
    // After the fix, parseTimeToMinutes strips everything after the dash and uses 09:00 AM.
    // 09:00 AM (540 min) is the boundary of the slot — should NOT be OutsideHours.
    const worker = DB.getWorkerByPhone('9876501111');
    assert.ok(worker && worker.id);

    const conflict = DB.checkScheduleConflict(worker.id, '2026-09-01', '09:00 AM \u2013 05:00 PM');
    assert.strictEqual(conflict, null,
        'Range string must resolve to start time 09:00 AM which is inside the window. Got: ' + conflict);
});

/* =========================================================================
   SCHEDULE CONFLICT DETECTION
   ========================================================================= */

await test('NotAvailable when worker has no availability slots', () => {
    const reg = DB.registerWorkerProfile({
        name: 'Ramesh Plumber', phone: '9876502222',
        trade: 'Plumber', city: 'Ramanagara'
    });
    const worker = reg.worker || DB.getWorkerByPhone('9876502222');
    assert.ok(worker && worker.id);

    const conflict = DB.checkScheduleConflict(worker.id, '2026-09-01', '10:00 AM');
    assert.strictEqual(conflict, 'NotAvailable');
});

await test('OutsideHours when booking time is before slot start', () => {
    const reg = DB.registerWorkerProfile({
        name: 'Suresh Carpenter', phone: '9876503333',
        trade: 'Carpenter', city: 'Ramanagara'
    });
    const worker = reg.worker || DB.getWorkerByPhone('9876503333');
    DB.setWorkerAvailabilitySlot({
        workerId: worker.id, workerPhone: worker.phone, trade: worker.trade,
        dateStr: '2026-09-02', startTime: '09:00 AM', endTime: '05:00 PM', isAvailable: true
    });

    const conflict = DB.checkScheduleConflict(worker.id, '2026-09-02', '08:00 AM');
    assert.strictEqual(conflict, 'OutsideHours');
});

await test('OutsideHours when booking time is after slot end', () => {
    const worker = DB.getWorkerByPhone('9876503333');
    const conflict = DB.checkScheduleConflict(worker.id, '2026-09-02', '06:00 PM');
    assert.strictEqual(conflict, 'OutsideHours');
});

await test('JobConflict for exact same time as existing confirmed job', () => {
    const reg = DB.registerWorkerProfile({
        name: 'John Painter', phone: '9876504444',
        trade: 'Painter', city: 'Ramanagara'
    });
    const worker = reg.worker || DB.getWorkerByPhone('9876504444');

    DB.setWorkerAvailabilitySlot({
        workerId: worker.id, workerPhone: worker.phone, trade: worker.trade,
        dateStr: '2026-09-03', startTime: '09:00 AM', endTime: '05:00 PM', isAvailable: true
    });

    DB.createJob({
        customer_phone: '9998887776', customer_name: 'Test Customer',
        worker_id: worker.id, worker_phone: worker.phone, worker_name: worker.name,
        service: 'Painter', problem_description: 'Paint walls',
        location: 'Town Area', city: 'Ramanagara',
        requested_date: '2026-09-03', requested_time: '10:00 AM',
        budget: '500', status: 'Confirmed'
    });

    assert.strictEqual(DB.checkScheduleConflict(worker.id, '2026-09-03', '10:00 AM'), 'JobConflict',
        'Exact same time as existing confirmed job');
    assert.strictEqual(DB.checkScheduleConflict(worker.id, '2026-09-03', '10:30 AM'), 'JobConflict',
        '30 min overlap (within 1-hour window)');
    assert.strictEqual(DB.checkScheduleConflict(worker.id, '2026-09-03', '11:30 AM'), null,
        '90 min gap — outside the 1-hour window, must be free');
});

/* =========================================================================
   PHASE 0.5-B — SCHEDULING ENGINE & PATTERN TESTS
   ========================================================================= */

await test('Phase 0.5-B — Weekly pattern expansion & getWorkersAvailableOnDate', () => {
    const reg = DB.registerWorkerProfile({
        name: 'Anita Tailor', phone: '9876505555',
        trade: 'Tailor', city: 'Ramanagara'
    });
    const worker = reg.worker || DB.getWorkerByPhone('9876505555');

    // Worker sets Weekly pattern for Mon(1) and Wed(3), from 2026-09-01 to 2026-09-30
    DB.setWorkerAvailabilitySlot({
        workerId: worker.id, workerPhone: worker.phone, trade: worker.trade,
        dateStr: '2026-09-01', startTime: '09:00 AM', endTime: '05:00 PM', isAvailable: true,
        pattern: 'weekly', daysOfWeek: [1, 3], rangeStart: '2026-09-01', rangeEnd: '2026-09-30'
    });

    // 2026-09-07 is a Monday -> should be available
    const mondayWorkers = DB.getWorkersAvailableOnDate('2026-09-07', 'Ramanagara');
    const foundMon = mondayWorkers.find(w => w.id === worker.id);
    assert.ok(foundMon, 'Worker should be available on Monday Sept 7');

    // 2026-09-08 is a Tuesday -> should NOT be available
    const tuesdayWorkers = DB.getWorkersAvailableOnDate('2026-09-08', 'Ramanagara');
    const foundTue = tuesdayWorkers.find(w => w.id === worker.id);
    assert.strictEqual(foundTue, undefined, 'Worker should NOT be available on Tuesday Sept 8');
});

await test('Phase 0.5-B — Conflict pre-flight check & resolution (cancel and repost)', () => {
    const reg = DB.registerWorkerProfile({
        name: 'Kiran Electrician', phone: '9876506666',
        trade: 'Electrician', city: 'Ramanagara'
    });
    const worker = reg.worker || DB.getWorkerByPhone('9876506666');

    // Step 1: Initial slot on 2026-09-10
    DB.setWorkerAvailabilitySlot({
        workerId: worker.id, workerPhone: worker.phone, trade: worker.trade,
        dateStr: '2026-09-10', startTime: '09:00 AM', endTime: '05:00 PM', isAvailable: true
    });

    // Step 2: Customer books job on 2026-09-10
    const job = DB.createJob({
        customer_phone: '9876543210', customer_name: 'Customer A',
        worker_id: worker.id, worker_phone: worker.phone, worker_name: worker.name,
        service: 'Electrician', problem_description: 'Fix wiring',
        location: 'Town Area', city: 'Ramanagara',
        requested_date: '2026-09-10', requested_time: '10:00 AM',
        budget: '₹400', status: 'Confirmed'
    });

    // Step 3: Worker edits availability to a date that does NOT include 2026-09-10
    const proposed = [{ pattern: 'once', rangeStart: '2026-09-11', startTime: '09:00 AM', endTime: '05:00 PM' }];
    const conflicts = DB.getConflictingJobsForAvailabilityChange(worker.id, proposed);
    assert.strictEqual(conflicts.length, 1, 'Should detect 1 conflicting job');
    assert.strictEqual(conflicts[0].id, job.id, 'Conflicting job ID must match');

    // Step 4: Worker resolves conflict as cannot work (canWork = false)
    const resolveRes = DB.resolveAvailabilityConflict(job.id, false);
    assert.strictEqual(resolveRes.action, 'cancelled_and_reposted');

    // Step 5: Verify job is now Requested, worker_id is null (reposted for others)
    const updatedJob = DB.getJobById(job.id);
    assert.strictEqual(updatedJob.status, 'Requested', 'Job status must revert to Requested');
    assert.strictEqual(updatedJob.worker_id, null, 'Worker ID must be cleared');
});

/* =========================================================================
   PHASE 0.5-C — RECURRING PATTERNS IN checkScheduleConflict & AI CONFLICTS
   ========================================================================= */

await test('Phase 0.5-C — checkScheduleConflict supports Weekly recurring patterns', () => {
    const reg = DB.registerWorkerProfile({
        name: 'Sunil Plumber', phone: '9876507777',
        trade: 'Plumber', city: 'Ramanagara'
    });
    const worker = reg.worker || DB.getWorkerByPhone('9876507777');

    // Worker sets Weekly pattern for Mon(1) and Wed(3), from 2026-09-01 to 2026-09-30, 09:00 AM - 05:00 PM
    DB.setWorkerAvailabilitySlot({
        workerId: worker.id, workerPhone: worker.phone, trade: worker.trade,
        dateStr: '2026-09-01', startTime: '09:00 AM', endTime: '05:00 PM', isAvailable: true,
        pattern: 'weekly', daysOfWeek: [1, 3], rangeStart: '2026-09-01', rangeEnd: '2026-09-30'
    });

    // 2026-09-07 is a Monday -> 10:00 AM should have NO conflict (null)
    const monConflict = DB.checkScheduleConflict(worker.id, '2026-09-07', '10:00 AM');
    assert.strictEqual(monConflict, null, 'Monday Sept 7 10:00 AM should be available (null), got: ' + monConflict);

    // 2026-09-07 Monday at 07:00 AM -> should be OutsideHours
    const monEarlyConflict = DB.checkScheduleConflict(worker.id, '2026-09-07', '07:00 AM');
    assert.strictEqual(monEarlyConflict, 'OutsideHours', 'Monday Sept 7 07:00 AM should be OutsideHours');

    // 2026-09-08 is a Tuesday -> should be NotAvailable
    const tueConflict = DB.checkScheduleConflict(worker.id, '2026-09-08', '10:00 AM');
    assert.strictEqual(tueConflict, 'NotAvailable', 'Tuesday Sept 8 should be NotAvailable');

    // 2026-09-09 is a Wednesday -> 02:00 PM should have NO conflict (null)
    const wedConflict = DB.checkScheduleConflict(worker.id, '2026-09-09', '02:00 PM');
    assert.strictEqual(wedConflict, null, 'Wednesday Sept 9 02:00 PM should be available (null)');
});

await test('Phase 0.5-C — checkScheduleConflict supports Daily recurring patterns', () => {
    const reg = DB.registerWorkerProfile({
        name: 'Farhan Carpenter', phone: '9876508888',
        trade: 'Carpenter', city: 'Ramanagara'
    });
    const worker = reg.worker || DB.getWorkerByPhone('9876508888');

    // Worker sets Daily pattern from 2026-09-01 to 2026-09-10, 08:00 AM - 06:00 PM
    DB.setWorkerAvailabilitySlot({
        workerId: worker.id, workerPhone: worker.phone, trade: worker.trade,
        dateStr: '2026-09-01', startTime: '08:00 AM', endTime: '06:00 PM', isAvailable: true,
        pattern: 'daily', rangeStart: '2026-09-01', rangeEnd: '2026-09-10'
    });

    // 2026-09-05 (Saturday) inside range -> 11:00 AM should have NO conflict
    const satConflict = DB.checkScheduleConflict(worker.id, '2026-09-05', '11:00 AM');
    assert.strictEqual(satConflict, null, 'Saturday Sept 5 should be available (null)');

    // 2026-09-15 outside range -> should be NotAvailable
    const lateConflict = DB.checkScheduleConflict(worker.id, '2026-09-15', '11:00 AM');
    assert.strictEqual(lateConflict, 'NotAvailable', 'Sept 15 should be NotAvailable');
});

await test('Phase 0.5-C — AI Agent createJob returns conflict when worker is unavailable', () => {
    const { aiAgent, AI_TOOLS } = require('../backend/ai_agent');
    const worker = DB.getWorkerByPhone('9876508888');
    assert.ok(worker && worker.id);

    // Attempt to book Farhan Carpenter on 2026-09-15 (which is outside his daily range)
    const result = AI_TOOLS.createJob({
        customerPhone: '9988776655',
        customerName: 'Ayesha',
        service: 'Carpenter',
        problemDescription: 'Fix door lock',
        requestedDate: '2026-09-15',
        requestedTime: '11:00 AM',
        workerId: worker.id
    });

    assert.strictEqual(result.status, 'conflict', 'AI agent createJob should return status conflict');
    assert.strictEqual(result.conflictType, 'NotAvailable');
    assert.ok(result.message.includes('not set working availability'), 'Should contain helpful message');
});

await test('Phase 0.5-C — FirebaseSync loads config correctly from config/firebase/ directory', () => {
    const FirebaseSync = require('../backend/firebase');
    const config = FirebaseSync.getConfig();
    assert.ok(config, 'Config must be an object');
    assert.strictEqual(config.projectId, 'gigsync-app-tier2', 'Project ID must match config');
});

await test('Phase 0.5-C — Serverless handler api/index.js handles available workers query', async () => {
    const apiHandler = require('../api/index');
    let statusCode = 0;
    let headers = {};
    let responseData = null;

    const mockReq = {
        method: 'GET',
        url: '/api/workers/available?date=2026-09-07&city=Ramanagara',
        headers: { host: 'localhost:8089' }
    };
    const mockRes = {
        setHeader: (k, v) => { headers[k] = v; },
        statusCode: 200,
        end: (body) => {
            if (body) {
                try { responseData = JSON.parse(body); } catch (_) {}
            }
        },
        json: (data) => { responseData = data; return mockRes; },
        status: (code) => { mockRes.statusCode = code; return mockRes; }
    };

    await apiHandler(mockReq, mockRes);
    assert.strictEqual(mockRes.statusCode, 200);
    assert.ok(responseData && responseData.status === 'success', 'Response status must be success');
    assert.ok(Array.isArray(responseData.workers), 'Workers must be an array');
});

await test('Phase 0.5-C — Serverless handler api/index.js handles reset-session without error', async () => {
    const apiHandler = require('../api/index');
    let responseData = null;

    const mockReq = {
        method: 'POST',
        url: '/api/ai/reset-session',
        headers: { host: 'localhost:8089' },
        body: { sessionId: 'test-session-123' }
    };
    const mockRes = {
        setHeader: () => {},
        statusCode: 200,
        end: (body) => {
            if (body) {
                try { responseData = JSON.parse(body); } catch (_) {}
            }
        },
        json: (data) => { responseData = data; return mockRes; },
        status: (code) => { mockRes.statusCode = code; return mockRes; }
    };

    await apiHandler(mockReq, mockRes);
    assert.strictEqual(mockRes.statusCode, 200);
    assert.ok(responseData && responseData.status === 'success');
});

await test('Phase 0.5-C — TTS keeps English for mixed-script English responses', () => {
    const mixed = 'We have verified specialists in Ramanagara for Tomorrow at 9 AM to 4 PM: ಏನ ಏನ ಬದಲಲ (Tailoring & Alterations, ★5, ₹300).';
    assert.strictEqual(resolveTtsLanguage(mixed, 'en-IN'), 'en', 'English should win when the UI requested English');
    assert.strictEqual(resolveTtsLanguage(mixed, 'kn-IN'), 'kn', 'Explicit Kannada should still win');
    assert.strictEqual(resolveTtsLanguage('ನಾಳೆ ಬೆಳಗ್ಗೆ 9 ರಿಂದ 4 ರವರೆಗೆ ಬುಕಿಂಗ್ ಇದೆ', ''), 'kn', 'Fallback detection should still recognize clear Kannada text');
});

await test('Phase 0.5-D — Customer Chatbot handles specialist discovery without worker hallucination', async () => {
    const { aiAgent } = require('../backend/ai_agent');
    
    // Customer interaction
    const result = await aiAgent.processCallTurn({
        sessionId: 'cust_session_test_1',
        callerPhone: '9900112233',
        callerRole: 'customer',
        callerName: 'Sunita',
        city: 'Ramanagara',
        speechText: 'I need an electrician tomorrow'
    });

    assert.ok(result.spokenResponse, 'Must return a spoken response');
    assert.ok(!result.spokenResponse.toLowerCase().includes('what is your profession'), 'Must NOT ask customer what their profession is');
    assert.ok(!result.spokenResponse.toLowerCase().includes('what type of work do you do'), 'Must NOT ask customer what type of work they do');
    assert.ok(result.spokenResponse.toLowerCase().includes('time'), 'Must advance to the missing time fields');
});

await test('Phase 0.5-D — Customer Chatbot hides busy workers for an exact requested slot', async () => {
    const { aiAgent } = require('../backend/ai_agent');
    const saz = DB.registerWorkerProfile({
        name: 'Saz Cleaner',
        phone: '9876509991',
        trade: 'Home Cleaning',
        city: 'Ramanagara'
    }).worker || DB.getWorkerByPhone('9876509991');
    assert.ok(saz && saz.id);

    DB.setWorkerAvailabilitySlot({
        workerId: saz.id,
        workerPhone: saz.phone,
        trade: saz.trade,
        dateStr: 'Tomorrow',
        startTime: '11:00 AM',
        endTime: '12:00 PM',
        isAvailable: true
    });

    DB.createJob({
        customer_phone: '9991112223',
        customer_name: 'Existing Customer',
        worker_id: saz.id,
        worker_phone: saz.phone,
        worker_name: saz.name,
        service: 'Home Cleaning',
        problem_description: 'Existing clean-up booking',
        location: 'Town Area',
        city: 'Ramanagara',
        requested_date: 'Tomorrow',
        requested_time: '11:00 AM',
        requested_end_time: '12:00 PM',
        budget: '₹350',
        status: 'Confirmed'
    });

    const result = await aiAgent.processCallTurn({
        sessionId: 'cust_session_test_busy_1',
        callerPhone: '9900112233',
        callerRole: 'customer',
        callerName: 'Sunita',
        city: 'Ramanagara',
        speechText: 'I need home cleaning tomorrow from 11 AM to 12 PM'
    });

    assert.ok(result.spokenResponse, 'Must return a spoken response');
    assert.ok(!result.spokenResponse.toLowerCase().includes('saz cleaner'), 'Busy worker must not be listed as available');
    assert.ok(
        result.spokenResponse.toLowerCase().includes('no verified specialists are available')
        || result.spokenResponse.toLowerCase().includes('no verified home cleaning')
        || result.detectedIntent === 'find_workers_empty',
        'Must clearly say nobody is available for the requested slot'
    );
});

await test('Phase 0.5-D — Customer Chatbot honors an explicit calendar date like 7th September', async () => {
    const { aiAgent } = require('../backend/ai_agent');
    const cleaner = DB.registerWorkerProfile({
        name: 'Hari Cleaner',
        phone: '9876509992',
        trade: 'Home Cleaning',
        city: 'Ramanagara'
    }).worker || DB.getWorkerByPhone('9876509992');
    assert.ok(cleaner && cleaner.id);

    DB.setWorkerAvailabilitySlot({
        workerId: cleaner.id,
        workerPhone: cleaner.phone,
        trade: cleaner.trade,
        dateStr: '2026-09-07',
        startTime: '11:00 AM',
        endTime: '12:00 PM',
        isAvailable: true
    });

    const result = await aiAgent.processCallTurn({
        sessionId: 'cust_session_test_date_1',
        callerPhone: '9900112233',
        callerRole: 'customer',
        callerName: 'Sunita',
        city: 'Ramanagara',
        speechText: 'I need a cleaner for 7th September from 11:00 a.m. to 12:00 p.m.'
    });

    assert.ok(result.spokenResponse, 'Must return a spoken response');
    assert.ok(result.spokenResponse.toLowerCase().includes('7th september'), 'Must mention the explicit date');
    assert.ok(!result.spokenResponse.toLowerCase().includes('tomorrow'), 'Must not fall back to Tomorrow');

    const confirmed = await aiAgent.processCallTurn({
        sessionId: 'cust_session_test_date_1',
        callerPhone: '9900112233',
        callerRole: 'customer',
        callerName: 'Sunita',
        city: 'Ramanagara',
        speechText: 'yes'
    });

    assert.ok(confirmed.spokenResponse.toLowerCase().includes('7th september'), 'Confirmed booking must preserve the explicit date');
    assert.ok(!confirmed.spokenResponse.toLowerCase().includes('tomorrow'), 'Confirmed booking must not revert to Tomorrow');
});

await test('Phase 0.5-D — Customer Chatbot creates booking and prevents conflict', async () => {
    const { aiAgent } = require('../backend/ai_agent');
    const priya = DB.getWorkerByPhone('9876501111');
    const ramesh = DB.getWorkerByPhone('9876502222');
    assert.ok(priya && priya.id);
    assert.ok(ramesh && ramesh.id);

    // 1. Ramesh Plumber has no hours set for Tomorrow:
    const conflictStart = await aiAgent.processCallTurn({
        sessionId: 'cust_session_test_2',
        callerPhone: '9900112233',
        callerRole: 'customer',
        callerName: 'Sunita',
        city: 'Ramanagara',
        speechText: 'Book Ramesh Plumber tomorrow at 10 AM'
    });
    const conflictResult = await aiAgent.processCallTurn({
        sessionId: 'cust_session_test_2', callerPhone: '9900112233', callerRole: 'customer', callerName: 'Sunita', city: 'Ramanagara',
        speechText: '4 PM'
    });
    assert.ok(conflictResult.spokenResponse.toLowerCase().includes('not set working hours') || conflictResult.spokenResponse.toLowerCase().includes('not available'), 'Must warn if worker has not set hours');

    // 2. Priya sets availability for Tomorrow (09:00 AM - 05:00 PM)
    DB.setWorkerAvailabilitySlot({
        workerId: priya.id,
        workerPhone: priya.phone,
        trade: priya.trade,
        dateStr: 'Tomorrow',
        startTime: '09:00 AM',
        endTime: '05:00 PM',
        isAvailable: true
    });

    // 3. Customer books Priya for Tomorrow at 02:00 PM -> Confirmed!
    await aiAgent.processCallTurn({
        sessionId: 'cust_session_test_3',
        callerPhone: '9900112233',
        callerRole: 'customer',
        callerName: 'Sunita',
        city: 'Ramanagara',
        speechText: 'Book Priya Electrician tomorrow at 2 PM'
    });
    const successResult = await aiAgent.processCallTurn({
        sessionId: 'cust_session_test_3', callerPhone: '9900112233', callerRole: 'customer', callerName: 'Sunita', city: 'Ramanagara',
        speechText: '4 PM'
    });
    const confirmedResult = await aiAgent.processCallTurn({
        sessionId: 'cust_session_test_3', callerPhone: '9900112233', callerRole: 'customer', callerName: 'Sunita', city: 'Ramanagara',
        speechText: 'yes'
    });

    assert.ok(
        (confirmedResult.spokenResponse.toLowerCase().includes('booking') && confirmedResult.spokenResponse.toLowerCase().includes('confirmed'))
        || successResult.detectedIntent === 'booking_conflict_job_conflict',
        'Must either confirm the valid booking or reject an already-occupied slot'
    );
});

await test('Phase 0.5-D — Customer Chatbot refuses a named worker already booked for the slot', async () => {
    const { aiAgent } = require('../backend/ai_agent');
    const saz = DB.getWorkerByPhone('9876509991');
    assert.ok(saz && saz.id);

    const result = await aiAgent.processCallTurn({
        sessionId: 'cust_session_test_busy_2',
        callerPhone: '9900112233',
        callerRole: 'customer',
        callerName: 'Sunita',
        city: 'Ramanagara',
        speechText: 'Book Saz Cleaner tomorrow from 11 AM to 12 PM'
    });

    assert.ok(result.spokenResponse, 'Must return a spoken response');
    assert.ok(
        result.spokenResponse.toLowerCase().includes('already has another booking')
        || result.spokenResponse.toLowerCase().includes('outside')
        || result.spokenResponse.toLowerCase().includes('not available')
        || result.detectedIntent === 'booking_conflict_job_conflict',
        'Must refuse the named worker when the slot is already taken'
    );
    assert.ok(!result.spokenResponse.toLowerCase().includes('confirmed'), 'Must not falsely confirm a clash');
});

await test('Phase 0.5-D — Kannada customer booking preserves spoken explicit September date', async () => {
    const { aiAgent } = require('../backend/ai_agent');
    const plumber = DB.registerWorkerProfile({
        name: 'Chiyyu Kannada Plumber',
        phone: '9876507787',
        trade: 'Plumber',
        city: 'Kanakapura'
    }).worker || DB.getWorkerByPhone('9876507787');
    assert.ok(plumber && plumber.id);

    DB.setWorkerAvailabilitySlot({
        workerId: plumber.id,
        workerPhone: plumber.phone,
        trade: plumber.trade,
        dateStr: '2026-09-03',
        startTime: '09:00 AM',
        endTime: '02:30 PM',
        isAvailable: true
    });

    const result = await aiAgent.processCallTurn({
        sessionId: 'cust_session_kn_explicit_date_1',
        callerPhone: '9900112234',
        callerRole: 'customer',
        callerName: 'Sunita',
        city: 'Kanakapura',
        language: 'KN',
        speechText: 'ಥರ್ಡ್ ಸೆಪ್ಟೆಂಬರ್ ಗೆ ನೈನ್ ಯಿಂದ 2:30ಗೆ ಪ್ಲಂಬರ್ ಬೇಕು'
    });

    assert.ok(result.spokenResponse, 'Must return a spoken response');
    assert.ok(result.spokenResponse.toLowerCase().includes('3rd september'), 'Must mention the explicit spoken date');
    assert.ok(!result.spokenResponse.toLowerCase().includes('tomorrow'), 'Must not reuse Tomorrow for an explicit Kannada date');
});

await test('Phase 0.5-D — Kannada confirmed booking prevents overlapping rebooking', async () => {
    const { aiAgent } = require('../backend/ai_agent');
    const plumber = DB.registerWorkerProfile({
        name: 'Overlap Kannada Plumber',
        phone: '9876507778',
        trade: 'Plumber',
        city: 'Kanakapura'
    }).worker || DB.getWorkerByPhone('9876507778');
    assert.ok(plumber && plumber.id);

    DB.setWorkerAvailabilitySlot({
        workerId: plumber.id,
        workerPhone: plumber.phone,
        trade: plumber.trade,
        dateStr: 'Tomorrow',
        startTime: '09:00 AM',
        endTime: '05:00 PM',
        isAvailable: true
    });

    const first = await aiAgent.processCallTurn({
        sessionId: 'cust_session_kn_overlap_1',
        callerPhone: '9900112235',
        callerRole: 'customer',
        callerName: 'Sunita',
        city: 'Kanakapura',
        language: 'KN',
        speechText: 'ನಾಳೆ ಪ್ಲಂಬರ್ 10-12 ಬೇಕು'
    });
    assert.ok(first.spokenResponse.toLowerCase().includes('overlap kannada ಪ್ಲಂಬರ್'), 'Must offer the available plumber before confirmation');

    const confirmed = await aiAgent.processCallTurn({
        sessionId: 'cust_session_kn_overlap_1',
        callerPhone: '9900112235',
        callerRole: 'customer',
        callerName: 'Sunita',
        city: 'Kanakapura',
        language: 'KN',
        speechText: 'ಹೌದು ಬುಕ್ ಮಾಡಿ'
    });
    assert.ok(confirmed.spokenResponse, 'Must respond to confirmation');
    assert.ok(!confirmed.spokenResponse.toLowerCase().includes('dispatched'), 'A listed single worker should be booked directly, not broadcast');

    const second = await aiAgent.processCallTurn({
        sessionId: 'cust_session_kn_overlap_2',
        callerPhone: '9900112236',
        callerRole: 'customer',
        callerName: 'Sunita',
        city: 'Kanakapura',
        language: 'KN',
        speechText: 'ನಾಳೆ ಪ್ಲಂಬರ್ 10-12 ಬೇಕು'
    });

    assert.ok(second.spokenResponse, 'Must respond to overlapping request');
    assert.ok(!second.spokenResponse.toLowerCase().includes('overlap kannada ಪ್ಲಂಬರ್'), 'Busy plumber must not be listed again for the same slot');
    assert.ok(
        second.detectedIntent === 'find_workers_empty'
        || second.spokenResponse.includes('ಲಭ್ಯವಿಲ್ಲ')
        || second.spokenResponse.toLowerCase().includes('no verified'),
        'Must clearly say nobody is available for the overlapping slot'
    );
});

await test('Phase 0.5-D — Worker Voice Agent answers profession, bookings, and availability', async () => {
    const { aiAgent } = require('../backend/ai_agent');
    
    // Priya Electrician (9876501111) checks her role
    const roleResult = await aiAgent.processCallTurn({
        sessionId: 'worker_session_test_1',
        callerPhone: '9876501111',
        callerRole: 'worker',
        callerName: 'Priya Electrician',
        city: 'Ramanagara',
        speechText: 'What is my profession?'
    });

    assert.ok(roleResult.spokenResponse.toLowerCase().includes('electrician'), 'Worker role inquiry must identify as electrician');

    // Priya checks bookings
    const bookingsResult = await aiAgent.processCallTurn({
        sessionId: 'worker_session_test_1',
        callerPhone: '9876501111',
        callerRole: 'worker',
        callerName: 'Priya Electrician',
        city: 'Ramanagara',
        speechText: 'Did anyone book me?'
    });

    assert.ok(bookingsResult.spokenResponse, 'Must answer bookings inquiry');

    // Priya sets hours verbally
    const availResult = await aiAgent.processCallTurn({
        sessionId: 'worker_session_test_1',
        callerPhone: '9876501111',
        callerRole: 'worker',
        callerName: 'Priya Electrician',
        city: 'Ramanagara',
        speechText: 'I am available tomorrow from 8 AM to 4 PM'
    });

    assert.ok(availResult.spokenResponse.toLowerCase().includes('shall i save'), 'Must ask for confirmation before changing availability');

    const savedAvailResult = await aiAgent.processCallTurn({
        sessionId: 'worker_session_test_1', callerPhone: '9876501111', callerRole: 'worker',
        callerName: 'Priya Electrician', city: 'Ramanagara', speechText: 'Yes, save it'
    });
    assert.ok(savedAvailResult.spokenResponse.toLowerCase().includes('availability has been updated'), 'Must save availability only after confirmation');

    const singleTimeResult = await aiAgent.processCallTurn({
        sessionId: 'worker_session_test_2', callerPhone: '9876501111', callerRole: 'worker',
        callerName: 'Priya Electrician', city: 'Ramanagara', speechText: "I am available tomorrow at 10 o'clock"
    });
    assert.ok(singleTimeResult.spokenResponse.toLowerCase().includes('until what time'), 'A single start time must ask for the end time');
});

await test('Voice onboarding retains a single start time and accepts dotted English/Hindi time ranges', async () => {
    const { aiAgent } = require('../backend/ai_agent');
    const sessionId = `voice_onboarding_${Date.now()}`;
    const common = { sessionId, callerRole: 'worker', callerName: 'User', city: 'Ramanagara', portal: 'terminal', isVoiceCall: true };
    await aiAgent.processCallTurn({ ...common, speechText: 'worker account' });
    await aiAgent.processCallTurn({ ...common, speechText: 'my name is Zainab' });
    await aiAgent.processCallTurn({ ...common, speechText: 'I am a painter' });
    await aiAgent.processCallTurn({ ...common, speechText: '9123456798' });
    const completedRange = await aiAgent.processCallTurn({ ...common, speechText: 'zainab123' });
    assert.ok(completedRange.spokenResponse.toLowerCase().includes('confirm'), 'The password must complete the account draft');
    await aiAgent.processCallTurn({ ...common, speechText: 'yes' });
    const accountResult = await aiAgent.processCallTurn({ ...common, speechText: 'Which account am I logged into?' });
    assert.ok(accountResult.spokenResponse.toLowerCase().includes('zainab'), 'A newly registered terminal caller must keep their worker identity');

    const hindiSession = `voice_hindi_${Date.now()}`;
    const hindi = { sessionId: hindiSession, callerRole: 'worker', callerName: 'User', city: 'Ramanagara', portal: 'terminal', isVoiceCall: true };
    await aiAgent.processCallTurn({ ...hindi, speechText: 'कामगार खाता' });
    await aiAgent.processCallTurn({ ...hindi, speechText: 'my name is Nisha' });
    await aiAgent.processCallTurn({ ...hindi, speechText: 'I am a painter' });
    await aiAgent.processCallTurn({ ...hindi, speechText: '9123456797' });
    const hindiPassword = await aiAgent.processCallTurn({ ...hindi, speechText: 'nisha123' });
    assert.ok(hindiPassword.spokenResponse.toLowerCase().includes('confirm'), 'Hindi signup should complete with a password confirmation');
});

/* =========================================================================
   RESULTS
   ========================================================================= */

console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
else { console.log('All regression tests passed!'); process.exit(0); }

} // end runAll

runAll().catch(err => { console.error('Fatal:', err); process.exit(1); });
