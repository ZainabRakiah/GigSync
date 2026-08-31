#!/usr/bin/env node
/* Feed text turns into the same handler used by /api/ai/voice-call.
 * Usage: node scripts/local_voice_test.js
 */
const { aiAgent } = require('../backend/ai_agent');
const DB = require('../backend/database');

const scenarios = [
  { language: 'EN', turns: ['I need an electrician tomorrow', '9 to 4', 'Yes, book Ramu'] },
  { language: 'HN', turns: ['कल हमें एक इलेक्ट्रिशियन चाहिए', '9 से 4', 'हाँ रामू को बुक करें'] },
  { language: 'KN', turns: ['ನಾಳೆ ನಮಗೆ ಒಂದು ಎಲೆಕ್ಟ್ರಿಷಿಯನ್ ಬೇಕಾಗಿತ್ತು', '9 ರಿಂದ 4', 'ಹೌದು ರಾಮುಗೆ ಬುಕ್ ಮಾಡಿ'] }
];

const languageFlag = process.argv.indexOf('--language');
const requestedLanguage = languageFlag >= 0 ? String(process.argv[languageFlag + 1] || '').toUpperCase() : '';
const interactive = process.argv.includes('--interactive');

(async () => {
  const runScenarios = interactive ? [{ language: requestedLanguage || 'EN', turns: [] }] : (requestedLanguage ? scenarios.filter(s => s.language === requestedLanguage) : scenarios);
  for (const scenario of runScenarios) {
    const phone = `9${Date.now().toString().slice(-9)}`;
    const sessionId = `local-cli-${scenario.language}-${Date.now()}`;
    const opts = { sessionId, callerPhone: phone, callerRole: 'customer', portal: 'customer', language: scenario.language };
    console.log(`\n=== ${scenario.language} ===`);
    let createdJob = null;
    let turns = scenario.turns;
    if (interactive) {
      const readline = require('node:readline/promises');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      console.log('Type caller turns; press Ctrl-D to finish.');
      turns = [];
      while (true) { const line = await rl.question('CALLER> '); if (!line.trim()) break; turns.push(line.trim()); }
      rl.close();
    }
    for (const caller of turns) {
      const result = await aiAgent.processCallTurn(opts, caller);
      createdJob = result.toolResult && result.toolResult.job ? result.toolResult.job : createdJob;
      console.log(`CALLER: ${caller}`);
      console.log(`GIGSYNC AI: ${result.spokenResponse}`);
      console.log(`INTENT: ${result.detectedIntent}`);
    }
    if (createdJob) {
      const stored = DB.getJobById(createdJob.id);
      console.log('JOB:', JSON.stringify({ id: stored.id, worker: stored.worker_name, date: stored.requested_date, time: stored.requested_time, status: stored.status }));
    } else {
      console.log('JOB: none created');
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
