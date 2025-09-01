import { getDayBounds } from './utils.js';

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

export function updateCharts(allMeals, selectedDate) {
    if (!calorieChart || !macroChart) return;

    // Grafico calorie (ultimi 7 giorni)
    const calorieLabels = [];
    const calorieData = [];
    for (let i = 6; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const { start, end } = getDayBounds(date);
        const dayCalories = allMeals
            .filter(meal => meal.jsDate >= start && meal.jsDate <= end)
            .reduce((sum, meal) => sum + ((Number(meal.calories) || 0) * (Number(meal.quantity) || 0) / 100), 0);
        calorieLabels.push(date.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }));
        calorieData.push(dayCalories.toFixed(0));
    }
    calorieChart.data.labels = calorieLabels;
    calorieChart.data.datasets[0].data = calorieData;
    calorieChart.update();

    // Grafico macro (giorno selezionato)
    const { start, end } = getDayBounds(selectedDate);
    const dayTotals = allMeals
        .filter(meal => meal.jsDate >= start && meal.jsDate <= end)
        .reduce((acc, meal) => {
            const ratio = (Number(meal.quantity) || 0) / 100;
            acc.proteins += (Number(meal.proteins) || 0) * ratio;
            acc.carbs += (Number(meal.carbs) || 0) * ratio;
            acc.fats += (Number(meal.fats) || 0) * ratio;
            return acc;
        }, { proteins: 0, carbs: 0, fats: 0 });

    macroChart.data.datasets[0].data = [dayTotals.proteins, dayTotals.carbs, dayTotals.fats];
    macroChart.update();
}

export function destroyCharts() {
    if (calorieChart) { calorieChart.destroy(); calorieChart = null; }
    if (macroChart) { macroChart.destroy(); macroChart = null; }
}