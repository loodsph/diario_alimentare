import { getDayBounds, getTodayUTC } from './utils.js';

let calorieChart = null;
let macroChart = null;

const defaultLineOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
        y: {
            beginAtZero: true,
            grid: { color: 'rgba(148, 163, 184, 0.1)' },
            ticks: { color: '#94a3b8' }
        },
        x: {
            grid: { display: false },
            ticks: { color: '#94a3b8' }
        }
    }
};

const defaultDoughnutOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { position: 'bottom', labels: { padding: 20, color: '#94a3b8' } } },
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
                borderColor: '#6366f1',
                backgroundColor: 'rgba(99, 102, 241, 0.1)',
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
                backgroundColor: ['#10b981', '#f59e0b', '#ef4444'],
                borderColor: ['#059669', '#d97706', '#dc2626'],
                borderWidth: 2,
                hoverOffset: 10
            }]
        },
        options: defaultDoughnutOptions
    });
}

export function updateCharts(dailyTotalsCache, selectedDate) {
    if (!calorieChart || !macroChart) return;

    // Grafico calorie (ultimi 7 giorni)
    const calorieLabels = [];
    const calorieData = [];
    for (let i = 6; i >= 0; i--) {
        const date = getTodayUTC(); // Inizia da oggi (UTC)
        date.setUTCDate(date.getUTCDate() - i);
        const dateKey = date.toISOString().split('T')[0];
        const dayTotals = dailyTotalsCache[dateKey];
        const dayCalories = dayTotals ? dayTotals.calories : 0;
        calorieLabels.push(date.toLocaleDateString('it-IT', { timeZone: 'UTC', day: 'numeric', month: 'short' }));
        calorieData.push(dayCalories.toFixed(0));
    }
    calorieChart.data.labels = calorieLabels;
    calorieChart.data.datasets[0].data = calorieData;
    calorieChart.update();
    
    // Grafico macro (giorno selezionato)
    const selectedDateKey = selectedDate.toISOString().split('T')[0];
    const dayTotals = dailyTotalsCache[selectedDateKey] || { proteins: 0, carbs: 0, fats: 0 };
    macroChart.data.datasets[0].data = [dayTotals.proteins, dayTotals.carbs, dayTotals.fats];
    macroChart.update();
}

export function destroyCharts() {
    if (calorieChart) { calorieChart.destroy(); calorieChart = null; }
    if (macroChart) { macroChart.destroy(); macroChart = null; }
}