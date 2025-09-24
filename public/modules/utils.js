export function debounce(func, delay) {
    let timeout;
    return function(...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), delay);
    };
}

/**
 * Restituisce la data odierna in UTC, con l'orario impostato a mezzogiorno per evitare problemi di fuso orario.
 */
export function getTodayUTC() {
    const today = new Date();
    // Usa i componenti della data locale (getFullYear, etc.) per costruire la data UTC.
    // Usare getUTCFullYear() può causare un errore di un giorno a seconda del fuso orario.
    // Se sono le 01:00 del 7 Settembre in GMT+2, in UTC sono ancora le 23:00 del 6 Settembre.
    return new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0));
}

export function getDayBounds(date) {
    const start = new Date(date);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setUTCHours(23, 59, 59, 999);
    return { start, end };
}

export function formatDate(date) {
    return date.toLocaleDateString('it-IT', {
        timeZone: 'UTC',
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

export function getMealTimestamp(type, selectedDate) {
    const mealDate = new Date(selectedDate);
    const today = getTodayUTC();

    if (
        selectedDate.getUTCFullYear() === today.getUTCFullYear() &&
        selectedDate.getUTCMonth() === today.getUTCMonth() &&
        selectedDate.getUTCDate() === today.getUTCDate()
    ) {
        // Se il pasto è di oggi, usa l'ora locale corrente ma applicala alla data UTC.
        // Questo assicura che un pasto aggiunto alle 01:00 del mattino non finisca nel giorno precedente in UTC.
        const now = new Date();
        mealDate.setUTCHours(now.getHours(), now.getMinutes(), now.getSeconds(), 0);
        return mealDate;
    }

    const defaultTimes = {
        '🌅 Colazione': 8,
        '🍽️ Pranzo': 13,
        '🌙 Cena': 20,
        '🍪 Spuntino': 16
    };
    mealDate.setUTCHours(defaultTimes[type] || 12, 0, 0, 0);
    return mealDate;
}