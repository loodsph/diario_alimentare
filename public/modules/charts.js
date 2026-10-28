import { calorieSeries } from './diary.js';
import { getDayBounds, getTodayUTC } from './utils.js';

let calorieChart = null;
let macroChart = null;
let themeQuery = null;

// I colori vengono dalle variabili CSS di input.css, così grafici e tema scuro restano allineati.
function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function withAlpha(hex, alpha) {
    const n = parseInt(hex.replace('#', ''), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function chartPalette() {
    return {
        muted: cssVar('--muted'),
        line: cssVar('--line'),
        accent: cssVar('--meal-colazione'),
        macros: [cssVar('--macro-protein'), cssVar('--macro-carbs'), cssVar('--macro-fat')]
    };
}

function applyPalette() {
    const c = chartPalette();
    if (calorieChart) {
        const { scales } = calorieChart.options;
        scales.y.grid.color = c.line;
        scales.y.ticks.color = c.muted;
        scales.x.ticks.color = c.muted;
        calorieChart.data.datasets[0].borderColor = c.accent;
        calorieChart.data.datasets[0].backgroundColor = withAlpha(c.accent, 0.12);
        calorieChart.update();
    }
    if (macroChart) {
        macroChart.options.plugins.legend.labels.color = c.muted;
        macroChart.data.datasets[0].backgroundColor = c.macros;
        macroChart.data.datasets[0].borderColor = c.macros;
        macroChart.update();
    }
}

const defaultLineOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
        y: { beginAtZero: true, grid: {}, ticks: {} },
        x: { grid: { display: false }, ticks: {} }
    }
};

const defaultDoughnutOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { position: 'bottom', labels: { padding: 20 } } },
    cutout: '70%'
};

export function initCharts(calorieCtx, macroCtx) {
    if (calorieChart) calorieChart.destroy();
    calorieChart = new Chart(calorieCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Calorie', data: [],
                tension: 0.4, fill: true
            }]
        },
        options: defaultLineOptions
    });

    if (macroChart) macroChart.destroy();
    macroChart = new Chart(macroCtx, {
        type: 'doughnut',
        data: {
            labels: ['Proteine', 'Carboidrati', 'Grassi'],
            datasets: [{
                data: [0, 0, 0],
                borderWidth: 2,
                hoverOffset: 10
            }]
        },
        options: defaultDoughnutOptions
    });

    applyPalette();
    if (!themeQuery) {
        themeQuery = window.matchMedia('(prefers-color-scheme: dark)');
        themeQuery.addEventListener('change', applyPalette);
    }
}

export function updateCharts(dailyTotalsCache, selectedDate) {
    if (!calorieChart || !macroChart) return;

    // Grafico calorie (ultimi 7 giorni)
    const series = calorieSeries(dailyTotalsCache, selectedDate);
    calorieChart.data.labels = series.map(point => point.date.toLocaleDateString('it-IT', { timeZone: 'UTC', day: 'numeric', month: 'short' }));
    calorieChart.data.datasets[0].data = series.map(point => point.value);
    calorieChart.data.datasets[0].spanGaps = false;

    // Grafico macro (giorno selezionato)
    const selectedDateKey = selectedDate.toISOString().split('T')[0];
    const selectedDayTotals = dailyTotalsCache[selectedDateKey] || { proteins: 0, carbs: 0, fats: 0 };
    const macroData = [Number(selectedDayTotals.proteins) || 0, Number(selectedDayTotals.carbs) || 0, Number(selectedDayTotals.fats) || 0];
    macroChart.data.datasets[0].data = macroData;
    
    calorieChart.update();
    macroChart.update();
}

export function destroyCharts() {
    if (calorieChart) { calorieChart.destroy(); calorieChart = null; }
    if (macroChart) { macroChart.destroy(); macroChart = null; }
}