export function fitImage(width, height, maxSide = 1600) {
    if (!(width > 0 && height > 0)) throw new Error('Immagine non valida.');
    const scale = Math.min(1, maxSide / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
export async function preparePhoto(file) {
    if (!file.type.startsWith('image/')) throw new Error('Scegli un’immagine.');
    if (file.size > 25 * 1024 * 1024) throw new Error('Scegli una foto inferiore a 25 MB.');
    const url = URL.createObjectURL(file);
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const { width, height } = fitImage(img.naturalWidth, img.naturalHeight);
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        return canvas.toDataURL('image/jpeg', 0.82);
    } finally { URL.revokeObjectURL(url); }
}
