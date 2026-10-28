// Firestore owns durable offline persistence. Never await server acknowledgement to
// release a form: its promise can remain pending for the entire offline session.
export function createWriteTracker(onChange, onError) {
    const pending = new Set();
    const failed = new Map();
    let generation = 0;
    const latest = new Map();
    const emit = () => onChange({ pending: pending.size, failed: failed.size });
    function submit(operation, { onSynced = () => {}, label = 'Salvataggio', key = Symbol() } = {}) {
        const session = generation;
        failed.delete(key);
        const ticket = Symbol();
        latest.set(key, ticket);
        pending.add(ticket); emit();
        const done = Promise.resolve().then(() => { if (session === generation) return operation(); }).then(() => {
            if (session === generation && latest.get(key) === ticket) onSynced();
        }).catch(error => {
            if (session !== generation || latest.get(key) !== ticket) return;
            failed.set(key, { operation, onSynced, label, key });
            onError(`${label} non riuscito. Puoi riprovare dal messaggio di sincronizzazione.`, error);
        }).finally(() => {
            if (session === generation) { pending.delete(ticket); emit(); }
        });
        return done;
    }
    return {
        submit,
        retry() { for (const task of [...failed.values()]) submit(task.operation, task); },
        reset() { generation++; pending.clear(); failed.clear(); latest.clear(); emit(); }
    };
}
