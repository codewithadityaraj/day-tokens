/**
 * ==========================================================================
 * LIVE POSTER DASHBOARD — APP ENGINE
 * Multi-program rotation every 10 seconds, live counters, audio, toasts
 * ==========================================================================
 */

'use strict';

// --------------------------------------------------------------------------
// 1. Programs Data
//    Live data is pulled from a published Google Sheet (CSV). The array below
//    is a fallback used only if the sheet can't be reached.
//    Each program has: name (displayed), target, achieved
// --------------------------------------------------------------------------
const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSYw0XpoBrl5gNAHq3n2p-OLAEOHwsBVVQy70ffPRRSk2SloYaqPPZ1X6YcuesaGvzlgf1EDUE8bwJV/pub?gid=1315863250&single=true&output=csv";
const SHEET_REFRESH_MS = 30000; // re-fetch the sheet every 30s

let programs = [
    { name: "IIT Jodhpur — BSc / BS Program",      institute: "IIT-Jodhpur", target: 25, achieved: 15 },
    { name: "IIT Jodhpur — MTech — CSE",            institute: "IIT-Jodhpur", target: 20, achieved: 12 },
    { name: "IIT Jodhpur — MTech — AI & ML",        institute: "IIT-Jodhpur", target: 22, achieved: 18 },
    { name: "IIT Jodhpur — PhD — Engineering",      institute: "IIT-Jodhpur", target: 10, achieved:  7 },
    { name: "IIT Jodhpur — MBA — Technology Mgmt",  institute: "IIT-Jodhpur", target: 18, achieved:  9 },
    { name: "IIT Jodhpur — BTech — EE",             institute: "IIT-Jodhpur", target: 30, achieved: 21 },
    { name: "IIT Jodhpur — BTech — ME",             institute: "IIT-Jodhpur", target: 28, achieved: 14 },
    { name: "IIT Jodhpur — BTech — Civil",          institute: "IIT-Jodhpur", target: 24, achieved: 16 },
    { name: "IIT Jodhpur — BTech — Chemical",       institute: "IIT-Jodhpur", target: 20, achieved: 11 },
    { name: "IIT Jodhpur — MTech — Data Science",   institute: "IIT-Jodhpur", target: 15, achieved: 10 },
    { name: "IIT Jodhpur — MSc — Mathematics",      institute: "IIT-Jodhpur", target: 12, achieved:  8 },
    { name: "IIT Jodhpur — MSc — Physics",          institute: "IIT-Jodhpur", target: 14, achieved:  9 },
    { name: "IIT Jodhpur — MTech — Bioscience",     institute: "IIT-Jodhpur", target: 16, achieved:  6 },
    { name: "IIT Jodhpur — PhD — Sciences",         institute: "IIT-Jodhpur", target: 10, achieved:  4 },
];

// --------------------------------------------------------------------------
// 2. Runtime State
// --------------------------------------------------------------------------
let currentProgramIndex = 0;
let autoRotate = true;
let rotateTimer = null;
let countdownInterval = null;
const FLIP_DURATION_MS = 10000; // 10 seconds per program
let flipStartTime = null;

let audioCtx = null;
let simulationIntervalId = null;

// Previous values for animation ticking
const prev = { target: 0, achieved: 0, percent: 0 };
const activeCounters = {};

// SVG circle math — r=52, viewBox 130×130
const CIRC = 2 * Math.PI * 52; // ≈ 326.73

// --------------------------------------------------------------------------
// 3. Boot
// --------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
    initClock();
    initFullscreen();
    initSecretTriggers();
    initControlPanel();
    initAudioToggle();
    initSimulator();

    // Pull live data from the Google Sheet before first paint (falls back to
    // the hardcoded array if the fetch fails).
    await loadProgramsFromSheet({ firstLoad: true });

    populateProgramJumpList();
    renderProgram(currentProgramIndex, false);
    startRotation();

    // Keep refreshing from the sheet so the poster stays live.
    setInterval(() => loadProgramsFromSheet({ firstLoad: false }), SHEET_REFRESH_MS);
});

// --------------------------------------------------------------------------
// 3b. Live data — fetch & parse the published Google Sheet CSV
// --------------------------------------------------------------------------
async function loadProgramsFromSheet({ firstLoad }) {
    try {
        const res = await fetch(SHEET_CSV_URL, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const rows = parseCSV(text);
        if (rows.length < 2) throw new Error('No data rows');

        // Map headers (case-insensitive) so column order can change safely.
        const header = rows[0].map(h => h.trim().toLowerCase());
        const iName      = header.findIndex(h => h.includes('program'));
        const iInstitute = header.findIndex(h => h.includes('institut'));
        const iTarget    = header.findIndex(h => h.includes('target'));
        const iAchieved  = header.findIndex(h => h.includes('achiev'));
        if (iName < 0 || iTarget < 0 || iAchieved < 0) throw new Error('Missing expected columns');

        const fresh = rows.slice(1)
            .filter(r => (r[iName] || '').trim() !== '')
            .map(r => ({
                name:      r[iName].trim(),
                institute: iInstitute >= 0 ? (r[iInstitute] || '').trim() : '',
                target:    Math.max(0, parseInt(r[iTarget], 10) || 0),
                achieved:  Math.max(0, parseInt(r[iAchieved], 10) || 0),
            }));
        if (fresh.length === 0) throw new Error('No valid programs');

        if (firstLoad) {
            programs = fresh;
            return;
        }

        // On a refresh: detect achievement increases for chime/toast, then
        // swap in the new data and re-render the visible program in place.
        const prevByName = new Map(programs.map(p => [p.name, p.achieved]));
        let gained = null;
        for (const p of fresh) {
            const before = prevByName.get(p.name);
            if (before !== undefined && p.achieved > before) gained = p;
        }

        const currentName = programs[currentProgramIndex]?.name;
        programs = fresh;
        // Keep pointing at the same program if it still exists; else clamp.
        const newIdx = programs.findIndex(p => p.name === currentName);
        currentProgramIndex = newIdx >= 0 ? newIdx
            : Math.min(currentProgramIndex, programs.length - 1);

        populateProgramJumpList();
        renderProgram(currentProgramIndex, false);

        if (gained) {
            playSuccessChime();
            showToast('TOKEN SECURED! 🎉', `${gained.name} — now at ${gained.achieved}`, 'success');
        }
    } catch (err) {
        if (firstLoad) {
            // Keep the fallback array; just let the user know we're offline-ish.
            console.warn('Sheet fetch failed, using fallback data:', err);
        } else {
            console.warn('Sheet refresh failed:', err);
        }
    }
}

// Minimal CSV parser that handles quoted fields, commas, and escaped quotes.
function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inQuotes) {
            if (c === '"') {
                if (s[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += c;
        } else {
            if (c === '"') inQuotes = true;
            else if (c === ',') { row.push(field); field = ''; }
            else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
            else field += c;
        }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
}

function formatInstituteName(institute) {
    if (!institute) return '';
    return institute.replace(/-/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
}

function getProgramDisplayName(name) {
    for (const sep of [' - ', ' — ']) {
        const idx = name.indexOf(sep);
        if (idx >= 0) return name.slice(idx + sep.length).trim();
    }
    return name;
}

// --------------------------------------------------------------------------
// 4. Fullscreen Toggle
// --------------------------------------------------------------------------
function initFullscreen() {
    const btn       = document.getElementById('fullscreen-btn');
    const iconEnter = document.getElementById('icon-enter-fs');
    const iconExit  = document.getElementById('icon-exit-fs');

    function updateIcons() {
        const isFS = !!(document.fullscreenElement ||
                        document.webkitFullscreenElement ||
                        document.mozFullScreenElement);
        iconEnter.style.display = isFS ? 'none'  : 'block';
        iconExit.style.display  = isFS ? 'block' : 'none';
        btn.title = isFS ? 'Exit Fullscreen' : 'Enter Fullscreen';
    }

    btn.addEventListener('click', () => {
        const el = document.documentElement;
        const isFS = !!(document.fullscreenElement ||
                        document.webkitFullscreenElement ||
                        document.mozFullScreenElement);
        if (!isFS) {
            if (el.requestFullscreen)             el.requestFullscreen();
            else if (el.webkitRequestFullscreen)  el.webkitRequestFullscreen();
            else if (el.mozRequestFullScreen)     el.mozRequestFullScreen();
        } else {
            if (document.exitFullscreen)             document.exitFullscreen();
            else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
            else if (document.mozCancelFullScreen)  document.mozCancelFullScreen();
        }
    });

    // Update icon whenever fullscreen state changes (e.g. user presses Esc)
    document.addEventListener('fullscreenchange',       updateIcons);
    document.addEventListener('webkitfullscreenchange', updateIcons);
    document.addEventListener('mozfullscreenchange',    updateIcons);
}

// --------------------------------------------------------------------------
// 5. Clock
// --------------------------------------------------------------------------
function initClock() {
    const el = document.getElementById('poster-clock');
    function tick() {
        const now = new Date();
        let h = now.getHours();
        const m = String(now.getMinutes()).padStart(2, '0');
        const ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        el.textContent = `${h}:${m} ${ampm}`;
    }
    tick();
    setInterval(tick, 1000);
}

// --------------------------------------------------------------------------
// 5. Program Rotation
// --------------------------------------------------------------------------
function startRotation() {
    stopRotation();
    if (!autoRotate) return;
    flipStartTime = Date.now();

    // Tick countdown bar every second
    countdownInterval = setInterval(() => {
        const elapsed = Date.now() - flipStartTime;
        const pct = Math.min(100, (elapsed / FLIP_DURATION_MS) * 100);
        const bar = document.getElementById('flip-progress-fill');
        if (bar) bar.style.width = pct + '%';
    }, 1000);

    // Flip at end of duration
    rotateTimer = setTimeout(() => {
        goToNextProgram();
    }, FLIP_DURATION_MS);
}

function stopRotation() {
    if (rotateTimer) { clearTimeout(rotateTimer); rotateTimer = null; }
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    const bar = document.getElementById('flip-progress-fill');
    if (bar) bar.style.width = '0%';
}

function goToNextProgram() {
    currentProgramIndex = (currentProgramIndex + 1) % programs.length;
    renderProgram(currentProgramIndex, true);
    startRotation();
}

function goToProgramIndex(idx) {
    stopRotation();
    currentProgramIndex = idx;
    renderProgram(currentProgramIndex, true);
    startRotation();
}

// --------------------------------------------------------------------------
// 6. Render — swap program data into the DOM with fade
// --------------------------------------------------------------------------
function renderProgram(idx, withFade) {
    const content = document.getElementById('poster-content');
    const prog = programs[idx];

    const doRender = () => {
        // Header: institute + program title
        const instituteEl = document.getElementById('label-institute-name');
        if (instituteEl) instituteEl.textContent = formatInstituteName(prog.institute);
        document.getElementById('label-program-name').textContent = getProgramDisplayName(prog.name);

        // Banner target label
        const bannerTarget = document.getElementById('banner-target-label');
        if (bannerTarget) bannerTarget.textContent = prog.target;

        // Program counter badge
        const counter = document.getElementById('program-counter');
        if (counter) counter.textContent = `${idx + 1} / ${programs.length}`;

        // Sync control panel inputs with current program
        document.getElementById('input-target').value = prog.target;
        document.getElementById('input-achieved').value = prog.achieved;

        // Animate KPI numbers
        const percent = Math.round((prog.achieved / Math.max(1, prog.target)) * 100);

        animateCounter('kpi-target-text',   prev.target,   prog.target,   '');
        animateCounter('kpi-achieved-text', prev.achieved, prog.achieved, '');
        animateCounter('kpi-percent-text',  prev.percent,  percent,       '%');

        // SVG ring
        updateRing(percent);

        // Save prev
        prev.target   = prog.target;
        prev.achieved = prog.achieved;
        prev.percent  = percent;
    };

    if (withFade) {
        content.classList.add('fading');
        setTimeout(() => {
            doRender();
            content.classList.remove('fading');
        }, 500);
    } else {
        doRender();
    }
}

// --------------------------------------------------------------------------
// 7. SVG Ring Update
// --------------------------------------------------------------------------
function updateRing(percent) {
    const circle = document.getElementById('progress-circle-fill');
    if (!circle) return;
    const clamped = Math.min(100, Math.max(0, percent));
    circle.style.strokeDashoffset = CIRC - (clamped / 100) * CIRC;
}

// --------------------------------------------------------------------------
// 8. Number Counter Animation
// --------------------------------------------------------------------------
function animateCounter(elementId, from, to, suffix = '', duration = 700) {
    const el = document.getElementById(elementId);
    if (!el) return;
    if (activeCounters[elementId]) cancelAnimationFrame(activeCounters[elementId]);
    if (from === to) { el.textContent = to + suffix; return; }

    const start = performance.now();
    function step(now) {
        const p = Math.min((now - start) / duration, 1);
        const ease = p * (2 - p); // ease-out quad
        el.textContent = Math.floor(from + (to - from) * ease) + suffix;
        if (p < 1) {
            activeCounters[elementId] = requestAnimationFrame(step);
        } else {
            el.textContent = to + suffix;
            delete activeCounters[elementId];
        }
    }
    activeCounters[elementId] = requestAnimationFrame(step);
}

// --------------------------------------------------------------------------
// 9. Audio — Web Audio chime
// --------------------------------------------------------------------------
function playSuccessChime() {
    if (!document.getElementById('chk-sound-chimes').checked) return;
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const now = audioCtx.currentTime;
        const osc1 = audioCtx.createOscillator();
        const osc2 = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc1.type = 'triangle'; osc1.frequency.setValueAtTime(523.25, now);
        osc1.frequency.exponentialRampToValueAtTime(783.99, now + 0.15);
        osc2.type = 'sine';    osc2.frequency.setValueAtTime(261.63, now);
        osc2.frequency.exponentialRampToValueAtTime(392.00, now + 0.2);
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.25, now + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
        osc1.connect(gain); osc2.connect(gain); gain.connect(audioCtx.destination);
        osc1.start(now); osc2.start(now);
        osc1.stop(now + 1); osc2.stop(now + 1);
    } catch(e) { /* Browser may block until user interaction */ }
}

function initAudioToggle() {
    const unlock = () => {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        document.body.removeEventListener('click', unlock);
    };
    document.body.addEventListener('click', unlock);
}

// --------------------------------------------------------------------------
// 10. Secret triggers — Shift+S and double-click logo open settings panel
// --------------------------------------------------------------------------
function initSecretTriggers() {
    const drawer   = document.getElementById('control-panel-drawer');
    const closeBtn = document.getElementById('panel-close-btn');
    const logoArea = document.getElementById('brand-logo-trigger');

    const open  = () => { drawer.classList.add('open'); drawer.setAttribute('aria-hidden','false'); };
    const close = () => { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden','true'); };

    closeBtn.addEventListener('click', close);
    logoArea.addEventListener('dblclick', open);

    document.addEventListener('keydown', e => {
        if (e.key === 'S' && e.shiftKey) {
            e.preventDefault();
            drawer.classList.contains('open') ? close() : open();
        }
    });

    document.addEventListener('click', e => {
        if (drawer.classList.contains('open') &&
            !drawer.contains(e.target) &&
            !logoArea.contains(e.target)) close();
    });
}

// --------------------------------------------------------------------------
// 11. Control Panel Inputs
// --------------------------------------------------------------------------
function initControlPanel() {
    const inputTarget   = document.getElementById('input-target');
    const inputAchieved = document.getElementById('input-achieved');

    // Live-update current program when inputs change
    inputTarget.addEventListener('input', () => {
        const v = parseInt(inputTarget.value);
        if (v > 0) {
            programs[currentProgramIndex].target = v;
            renderProgram(currentProgramIndex, false);
        }
    });

    inputAchieved.addEventListener('input', () => {
        const v = parseInt(inputAchieved.value);
        if (v >= 0) {
            const wasLess = v > programs[currentProgramIndex].achieved;
            programs[currentProgramIndex].achieved = v;
            renderProgram(currentProgramIndex, false);
            if (wasLess) playSuccessChime();
        }
    });

    document.getElementById('btn-increment-achieved').addEventListener('click', () => {
        programs[currentProgramIndex].achieved++;
        inputAchieved.value = programs[currentProgramIndex].achieved;
        renderProgram(currentProgramIndex, false);
        playSuccessChime();
    });

    document.getElementById('btn-decrement-achieved').addEventListener('click', () => {
        programs[currentProgramIndex].achieved = Math.max(0, programs[currentProgramIndex].achieved - 1);
        inputAchieved.value = programs[currentProgramIndex].achieved;
        renderProgram(currentProgramIndex, false);
    });

    // Auto rotation toggle
    document.getElementById('chk-auto-rotate').addEventListener('change', e => {
        autoRotate = e.target.checked;
        autoRotate ? startRotation() : stopRotation();
    });

    // Jump to program dropdown
    document.getElementById('btn-jump-program').addEventListener('click', () => {
        const idx = parseInt(document.getElementById('program-jump-select').value);
        if (!isNaN(idx)) goToProgramIndex(idx);
    });

    // Reset current program to initial defaults
    document.getElementById('btn-reset-simulator').addEventListener('click', () => {
        showToast('Reset', `Program data reset for ${programs[currentProgramIndex].name}`, 'info');
        renderProgram(currentProgramIndex, false);
    });
}

// --------------------------------------------------------------------------
// 12. Populate "Jump to Program" dropdown
// --------------------------------------------------------------------------
function populateProgramJumpList() {
    const sel = document.getElementById('program-jump-select');
    sel.innerHTML = '';
    programs.forEach((p, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = `${i + 1}. ${p.name}`;
        sel.appendChild(opt);
    });
}

// --------------------------------------------------------------------------
// 13. Simulator — manual & auto token events
// --------------------------------------------------------------------------
function initSimulator() {
    document.getElementById('btn-trigger-sale').addEventListener('click', () => {
        const rep = document.getElementById('sales-rep-selector').value;
        registerSale(rep);
    });

    document.getElementById('chk-auto-simulation').addEventListener('change', e => {
        if (e.target.checked) {
            showToast('Simulation On', 'Auto tokens firing every 8 seconds.', 'info');
            simulationIntervalId = setInterval(() => {
                const reps = ['Sarah Connor','Marcus Wright','Kyle Reese','John Connor','Dr. Silberman'];
                registerSale(reps[Math.floor(Math.random() * reps.length)]);
            }, 8000);
        } else {
            clearInterval(simulationIntervalId);
            simulationIntervalId = null;
            showToast('Simulation Off', 'Auto-token generator stopped.', 'info');
        }
    });
}

function registerSale(repName) {
    programs[currentProgramIndex].achieved++;
    document.getElementById('input-achieved').value = programs[currentProgramIndex].achieved;
    renderProgram(currentProgramIndex, false);
    playSuccessChime();
    showToast('TOKEN SECURED! 🎉', `${repName} just registered 1 token!`, 'success');
}

// --------------------------------------------------------------------------
// 14. Toast Notifications
// --------------------------------------------------------------------------
function showToast(headline, message, type = 'success') {
    const container = document.getElementById('toast-toaster-container');
    if (!container) return;
    if (container.children.length >= 3) container.firstChild?.remove();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    if (type === 'info') {
        toast.style.borderColor = 'rgba(0,53,102,0.35)';
    }

    toast.innerHTML = `
        <div class="toast-icon">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="9 11 12 14 17 9"></polyline>
            </svg>
        </div>
        <div class="toast-body">
            <span class="toast-headline">${esc(headline)}</span>
            <span class="toast-message">${esc(message)}</span>
        </div>`;

    container.appendChild(toast);
    const t = setTimeout(() => dismiss(toast), 4500);
    toast.addEventListener('click', () => { clearTimeout(t); dismiss(toast); });
}

function dismiss(toast) {
    toast.classList.add('toast-remove');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
}

function esc(str) {
    return String(str).replace(/[&<>'"]/g, c =>
        ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[c]));
}
