export function debounce(func, delay) {
    let timeout;
    return function(...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), delay);
    };
}

export function getDayBounds(date) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);
    return { start, end };
}

export function formatDate(date) {
    return date.toLocaleDateString('it-IT', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

export function getMealTimestamp(type, selectedDate) {
    let mealDate = new Date(selectedDate);
    if (selectedDate.toDateString() === new Date().toDateString()) {
        return new Date(); // Ora corrente se è oggi
    }
    const defaultTimes = {
        '🌅 Colazione': 8, '🍽️ Pranzo': 13, '🌙 Cena': 20, '🍪 Spuntino': 16
    };
    mealDate.setHours(defaultTimes[type] || 12, 0, 0, 0);
    return mealDate;
}