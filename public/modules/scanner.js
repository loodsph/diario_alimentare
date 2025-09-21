// Barcode scanner module
import { showToast } from './uiHelpers.js';
import {
    onDecodeCallback, html5QrCode, availableCameras, currentCameraIndex,
    setScannerState
} from './state.js';

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
        // Ottieni la lista delle fotocamere solo se non è già stata caricata.
        // Questo preserva la selezione dell'utente nelle aperture successive.
        if (availableCameras.length === 0) {
            const cameras = await window.Html5Qrcode.getCameras();
            if (!cameras || cameras.length === 0) {
                throw new Error("Nessuna fotocamera trovata.");
            }
            // Imposta la seconda fotocamera (indice 4) come predefinita, se esiste.
            const newCameraIndex = cameras.length > 3 ? 3 : 0;
            setScannerState(onDecode, html5QrCode, cameras, newCameraIndex);
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
            const newScanner = new window.Html5Qrcode("scanner-reader", {
                formatsToSupport: [
                    window.Html5QrcodeSupportedFormats.EAN_13,
                    window.Html5QrcodeSupportedFormats.EAN_8,
                    window.Html5QrcodeSupportedFormats.UPC_A,
                    window.Html5QrcodeSupportedFormats.UPC_E
                ]
            });
            setScannerState(onDecodeCallback, newScanner, availableCameras, currentCameraIndex);
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
        qrbox: { width: 250, height: 150 }
    };

    const onScanSuccess = async (decodedText, decodedResult) => {
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
        await startScanningWithCurrentCamera();
        showToast(`Fotocamera cambiata: ${availableCameras[newCameraIndex].label || `Fotocamera ${newCameraIndex + 1}`}`);
    }
}

export async function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    showToast('Elaborazione immagine...');

    let scanner = html5QrCode;
    if (!scanner) {
        scanner = new window.Html5Qrcode("scanner-reader");
        setScannerState(onDecodeCallback, scanner, availableCameras, currentCameraIndex);
    }

    try {
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

        const onAnimationEnd = () => {
            element.classList.remove('flash-scan-success');
            resolve();
        };
        element.addEventListener('animationend', onAnimationEnd, { once: true });
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