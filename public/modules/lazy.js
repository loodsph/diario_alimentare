const scripts = new Map();
export function loadScript(url) {
    if (!scripts.has(url)) {
        const task = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = url;
            script.async = true;
            script.onload = resolve;
            script.onerror = () => { script.remove(); reject(new Error('Impossibile caricare la funzione. Controlla la connessione e riprova.')); };
            document.head.appendChild(script);
        }).catch(error => { scripts.delete(url); throw error; });
        scripts.set(url, task);
    }
    return scripts.get(url);
}
