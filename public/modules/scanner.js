// Barcode scanner module
import { loadScript } from './lazy.js';
import { showToast } from './uiHelpers.js';

// Stato dello scanner, usato solo da questo modulo.
let onDecodeCallback = null;
let html5QrCode = null;
let availableCameras = [];
let currentCameraIndex = 0;

const LIBRARY_URL = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
const CAMERA_STORAGE = 'nutritrack-scanner-camera';
let scanHandled = false;

function savedCameraIndex(cameras) {
    try {
        const savedId = localStorage.getItem(CAMERA_STORAGE);
        return cameras.findIndex(camera => camera.id === savedId);
    } catch {
        return -1;
    }
}

function saveCamera(camera) {
    try {
        localStorage.setItem(CAMERA_STORAGE, camera.id);
    } catch { /* La scelta vale solo per questa sessione */ }
}

// Sceglie la fotocamera posteriore principale: le grandangolari, i teleobiettivi
// e le frontali non mettono a fuoco da vicino e non leggono i codici a barre.
export function pickDefaultCamera(cameras) {
    const labels = cameras.map(camera => (camera.label || '').toLowerCase());
    const isBack = label => /back|rear|environment|posterior/.test(label);
    const isSpecial = label => /ultra|wide|tele|dual|triple|front|anterior|user/.test(label);
    const index = labels.findIndex(label => isBack(label) && !isSpecial(label.replace(/back|rear/g, '')));
    if (index !== -1) return index;
    const anyBack = labels.findIndex(isBack);
    if (anyBack !== -1) return anyBack;
    return cameras.length - 1;
}

function createScanner() {
    return new window.Html5Qrcode("scanner-reader", {
        formatsToSupport: [
            window.Html5QrcodeSupportedFormats.EAN_13,
            window.Html5QrcodeSupportedFormats.EAN_8,
            window.Html5QrcodeSupportedFormats.UPC_A,
            window.Html5QrcodeSupportedFormats.UPC_E
        ],
        // Usa il lettore nativo del browser (Chrome Android) quando c'è: è molto più affidabile.
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        verbose: false
    });
}

function setScannerState(callback, qrCode, cameras, index) {
    onDecodeCallback = callback;
    html5QrCode = qrCode;
    availableCameras = cameras;
    currentCameraIndex = index;
}

export async function startScanner(onDecode) {
    // Update state
    setScannerState(onDecode, html5QrCode, availableCameras, currentCameraIndex);

    const scannerModal = document.getElementById('scanner-modal');
    const feedbackEl = document.getElementById('scanner-feedback');
    const cameraSelect = document.getElementById('camera-select');
    scannerModal.classList.remove('hidden');
    scannerModal.classList.add('flex');
    feedbackEl.textContent = 'Avvio fotocamera...';

    try {
        await loadScript(LIBRARY_URL);
        if (scannerModal.classList.contains('hidden')) return;
        // Ottieni la lista delle fotocamere solo se non è già stata caricata.
        // Questo preserva la selezione dell'utente nelle aperture successive.
        if (availableCameras.length === 0) {
            const cameras = await window.Html5Qrcode.getCameras();
            if (scannerModal.classList.contains('hidden')) return;
            if (!cameras || cameras.length === 0) {
                throw new Error("Nessuna fotocamera trovata.");
            }
            const saved = savedCameraIndex(cameras);
            setScannerState(onDecode, html5QrCode, cameras, saved !== -1 ? saved : pickDefaultCamera(cameras));
        }

        // Popola il dropdown delle fotocamere
        cameraSelect.innerHTML = '';
        availableCameras.forEach((camera, index) => {
            const option = document.createElement('option');
            option.value = camera.id;
            option.textContent = camera.label || `Fotocamera ${index + 1}`;
            cameraSelect.appendChild(option);
        });
        cameraSelect.selectedIndex = currentCameraIndex;

        // Crea l'istanza dello scanner se non esiste
        if (!html5QrCode) {
            setScannerState(onDecodeCallback, createScanner(), availableCameras, currentCameraIndex);
        }

        // Avvia la scansione con la fotocamera selezionata
        await startScanningWithCurrentCamera();

    } catch (err) {
        console.error("Errore critico avvio scanner:", err);
        feedbackEl.textContent = "Errore fotocamera. Controlla i permessi.";
        showToast("Impossibile avviare la fotocamera. Controlla i permessi del browser.", true);
    }
}

export async function startScanningWithCurrentCamera() {
    if (!html5QrCode || availableCameras.length === 0) return;

    const feedbackEl = document.getElementById('scanner-feedback');
    feedbackEl.textContent = 'Inquadra un codice a barre...';

    // Ferma la scansione precedente se attiva
    if (html5QrCode.isScanning) {
        await html5QrCode.stop();
    }

    const config = {
        fps: 10,
        // Area larga e bassa, proporzionata al riquadro: i codici EAN sono orizzontali.
        qrbox: (width, height) => ({
            width: Math.max(50, Math.floor(width * 0.85)),
            height: Math.max(50, Math.floor(Math.min(height * 0.5, width * 0.45)))
        }),
        // Risoluzione alta e messa a fuoco continua: le barre sottili richiedono dettaglio.
        videoConstraints: {
            deviceId: { exact: availableCameras[currentCameraIndex].id },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            advanced: [{ focusMode: 'continuous' }]
        }
    };

    scanHandled = false;
    const onScanSuccess = async (decodedText, decodedResult) => {
        // La libreria continua a chiamare questa funzione a ogni fotogramma finché non viene fermata.
        if (scanHandled) return;
        scanHandled = true;
        // Chiama la funzione centralizzata per il feedback
        await triggerSuccessFeedback();
        await stopScanner();
        showToast(`Codice trovato!`);
        if (onDecodeCallback) {
            onDecodeCallback(decodedText);
        }
        setScannerState(null, html5QrCode, availableCameras, currentCameraIndex);
    };

    const onScanFailure = (error) => { /* Ignora errori di non trovato */ };

    try {
        await html5QrCode.start(
            availableCameras[currentCameraIndex].id,
            config,
            onScanSuccess,
            onScanFailure
        );
    } catch (err) {
        console.error(`Errore avvio fotocamera ${availableCameras[currentCameraIndex].id}:`, err);
        feedbackEl.textContent = "Errore avvio fotocamera.";
        showToast("Impossibile avviare questa fotocamera.", true);
    }
}

export async function toggleFlash() {
    if (!html5QrCode || !html5QrCode.isScanning) {
        return showToast("Lo scanner non è attivo.", true);
    }

    try {
        const capabilities = html5QrCode.getRunningTrackCapabilities();
        const settings = html5QrCode.getRunningTrackSettings();

        if (!capabilities.torch) {
            return showToast("Il tuo dispositivo non supporta il controllo del flash.", true);
        }

        const newFlashState = !settings.torch;
        await html5QrCode.applyVideoConstraints({
            advanced: [{ torch: newFlashState }]
        });

        showToast(`Flash ${newFlashState ? 'attivato' : 'disattivato'}.`);
        document.getElementById('toggle-flash-btn').classList.toggle('btn-primary', newFlashState);
        document.getElementById('toggle-flash-btn').classList.toggle('bg-slate-600', !newFlashState);
    } catch (err) {
        console.error("Errore nel controllare il flash:", err);
        showToast("Impossibile controllare il flash.", true);
    }
}

export async function handleCameraChange(event) {
    // Aggiorna l'indice della fotocamera in base alla selezione dell'utente
    const newCameraIndex = event.target.selectedIndex;
    setScannerState(onDecodeCallback, html5QrCode, availableCameras, newCameraIndex);
    if (newCameraIndex !== -1) {
        saveCamera(availableCameras[newCameraIndex]);
        await startScanningWithCurrentCamera();
        showToast(`Fotocamera cambiata: ${availableCameras[newCameraIndex].label || `Fotocamera ${newCameraIndex + 1}`}`);
    }
}

export async function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    showToast('Elaborazione immagine...');

    let scanner = html5QrCode;
    try {
        await loadScript(LIBRARY_URL);
        if (!scanner) {
            scanner = createScanner();
            setScannerState(onDecodeCallback, scanner, availableCameras, currentCameraIndex);
        }
        if (scanner.isScanning) await scanner.stop();
        const decodedText = await scanner.scanFile(file, false);
        // Chiama la funzione centralizzata per il feedback
        await triggerSuccessFeedback();
        await stopScanner();
        showToast(`Codice trovato!`);
        if (onDecodeCallback) {
            onDecodeCallback(decodedText);
        }
    } catch (err) {
        console.error("Errore scansione file:", err);
        showToast("Nessun codice a barre trovato nell'immagine.", true);
    } finally {
        setScannerState(null, scanner, availableCameras, currentCameraIndex);
        event.target.value = ''; // Permette di ricaricare lo stesso file
    }
}

/**
 * Gestisce il feedback di successo (vibrazione e animazione) in modo centralizzato.
 */
export async function triggerSuccessFeedback() {
    // Esegue l'animazione visiva
    await playScanSuccessAnimation('scanner-reader');
}

/**
 * Applica un'animazione a un elemento e restituisce una Promise che si risolve
 * quando l'animazione è terminata.
 * @param {string} elementId L'ID dell'elemento da animare.
 * @returns {Promise<void>}
 */
export function playScanSuccessAnimation(elementId) {
    return new Promise(resolve => {
        const element = document.getElementById(elementId);
        if (!element) return resolve();

        let done = false;
        const onAnimationEnd = () => {
            if (done) return;
            done = true;
            element.classList.remove('flash-scan-success');
            resolve();
        };
        element.addEventListener('animationend', onAnimationEnd, { once: true });
        // Se l'animazione non parte (CSS mancante, movimento ridotto) non bloccare la scansione.
        setTimeout(onAnimationEnd, 700);
        element.classList.add('flash-scan-success');
    });
}

export async function stopScanner() {
    const scannerModal = document.getElementById('scanner-modal');
    scannerModal.classList.add('hidden');
    scannerModal.classList.remove('flex');

    if (html5QrCode && html5QrCode.isScanning) {
        try {
            await html5QrCode.stop();
            // Resetta lo stato del pulsante del flash quando lo scanner si ferma
            const flashBtn = document.getElementById('toggle-flash-btn');
            flashBtn.classList.remove('btn-primary');
            flashBtn.classList.add('bg-slate-600');
        } catch (err) {
            console.error("Errore stop scanner:", err);
        }
    }
}